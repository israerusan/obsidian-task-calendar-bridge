import { isValidDate, normalizeTime, compareDates, weekdayOf, dayOfMonth, daysInMonth } from "./dates";
import { parseRecurrence } from "./recurrence";
import { stripTrailingNotes, TAG_PATTERN } from "./text";
import type { CalendarTask, ParseOptions, ParseResult, SkippedTask, TaskStatus } from "./types";

/**
 * Markdown -> calendar tasks.
 *
 * Three rules shape this file:
 *  1. Never invent data. A malformed date is reported, never guessed at.
 *  2. Never silently drop a task the user reasonably expected to see — every
 *     rejection produces a SkippedTask the UI can show.
 *  3. A malformed *decoration* (a bad time, a bad end date) degrades that field.
 *     Only a missing or malformed placement date can remove the whole task.
 */

// List markers: `-`, `*`, `+`, `1.`, `1)`. Checkbox holds any single character
// so custom Tasks statuses (`[/]`, `[-]`, `[>]`) are recognised, not ignored.
const TASK_RE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+\[(.)\]\s*(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/;
const BLOCK_ID_RE = /\s\^([A-Za-z0-9-]+)\s*$/;
const DATE_SHAPE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A duration longer than a year is a typo, and PT<huge>M breaks calendar apps. */
const MAX_DURATION_MINUTES = 366 * 24 * 60;

/**
 * Title cleanup runs several patterns of the `\[([^\]]+)\]…` shape, which are
 * inherently quadratic in line length when the closing delimiter never arrives.
 * A task is one line of prose; a 2 000-character one is a pasted blob, and
 * without this bound a single such line froze the editor for seconds mid-export.
 */
const MAX_TASK_LINE = 2000;

const EMOJI = {
  due: "\u{1F4C5}\u{1F4C6}\u{1F5D3}",
  scheduled: "\u{23F3}\u{231B}",
  start: "\u{1F6EB}",
  done: "\u{2705}",
  cancelled: "\u{274C}",
  created: "\u{2795}",
  recurrence: "\u{1F501}",
  id: "\u{1F194}",
  dependsOn: "\u{26D4}",
} as const;

// Maps rather than plain objects: a lookup such as PRIORITY_WORDS["constructor"]
// resolves up the prototype chain to a function, which was then written into the
// ICS file as a property value and corrupted the whole calendar.
const PRIORITY_EMOJI = new Map<string, number>([
  ["\u{1F53A}", 1], // highest
  ["\u{23EB}", 2], // high
  ["\u{1F53C}", 4], // medium
  ["\u{1F53D}", 7], // low
  ["\u{23EC}", 9], // lowest
]);

const PRIORITY_WORDS = new Map<string, number>([
  ["highest", 1], ["urgent", 1],
  ["high", 2],
  ["medium", 4], ["normal", 4],
  ["low", 7],
  ["lowest", 9],
]);

const DATE_EMOJI = EMOJI.due + EMOJI.scheduled + EMOJI.start + EMOJI.done + EMOJI.cancelled + EMOJI.created;
const PRIORITY_CHARS = [...PRIORITY_EMOJI.keys()].join("");
const ALL_EMOJI = Object.values(EMOJI).join("") + PRIORITY_CHARS;

/**
 * Fields whose value is a single token (a date, a time, one word, one id).
 * Capturing greedily here was a regression: `due:: 2026-08-02 #work` swallowed
 * the tag into the date and skipped the whole task.
 */
const SINGLE_TOKEN_FIELDS = ["due", "scheduled", "start", "end", "priority", "id"];
/** Fields whose value is genuinely multi-word (`every 2 weeks on Monday`). */
const FREE_TEXT_FIELDS = ["duration", "reminder", "repeat", "recurrence"];
const FIELD_NAMES = [...SINGLE_TOKEN_FIELDS, ...FREE_TEXT_FIELDS];

export function parseTasksFromMarkdown(markdown: string, sourcePath: string, options: ParseOptions): ParseResult {
  const tasks: CalendarTask[] = [];
  const skipped: SkippedTask[] = [];
  const titleCounts = new Map<string, number>();

  const lines = markdown.split(/\r?\n/);
  const fenced = findFencedLines(lines);

  for (let index = 0; index < lines.length; index++) {
    // A "task" inside a code fence is documentation, not a commitment.
    if (fenced.has(index)) continue;

    // Callout and blockquote content is real content; the `>` markers are not.
    const line = stripQuoteMarkers(lines[index]);
    const match = TASK_RE.exec(line);
    if (!match) continue;

    const lineNumber = index + 1;
    const status = readStatus(match[2]);
    const body = match[3].trim();
    if (!body) continue;

    // Flattened, not sliced. A substring in V8 is a view that keeps its parent
    // alive, so a 120-character excerpt of one task line pinned the entire text
    // of the note it came from — and the parse cache holds one of these per file,
    // so a large vault ended up holding a second copy of itself in memory.
    const excerpt = flatten(line.trim().slice(0, 120));
    // `fatal` distinguishes "this task is not in your calendar" from "one field
    // of it was ignored", which the export notice counts very differently.
    const skip = (reason: SkippedTask["reason"], detail: string, fatal = true): void => {
      skipped.push({ sourcePath, line: lineNumber, reason, detail, excerpt, fatal });
    };

    if (body.length > MAX_TASK_LINE) {
      skip("line-too-long", `This task line is ${body.length} characters. Shorten it to under ${MAX_TASK_LINE} to export it.`);
      continue;
    }

    const fields = readFields(body);
    const title = cleanTitle(body) || "Untitled task";

    // Counted before any filtering. Counting only exported tasks made identity
    // depend on what was filtered out, so ticking off one `Standup` renumbered
    // every later one and rewrote their UIDs.
    // Keyed on the title alone: keying on title+date reset the counter for
    // every date, so `Standup` on three days hashed to one id and two vanished.
    const occurrence = titleCounts.get(title) ?? 0;
    titleCounts.set(title, occurrence + 1);

    if (status === "done" && !options.includeCompleted) {
      skip("completed", "Completed tasks are excluded.");
      continue;
    }
    if (status === "cancelled" && !options.includeCompleted) {
      skip("cancelled", "Cancelled tasks are excluded.");
      continue;
    }

    // `[start:: …]` is polymorphic: a time of day, or a date written the long
    // way. Validating one as the other rejected valid tasks. A 🛫 date always
    // lives in its own slot and is the fallback when the inline field is a time.
    const inlineStartIsDate = fields.start !== undefined && DATE_SHAPE_RE.test(fields.start);
    const startDate = inlineStartIsDate ? fields.start : fields.startDate;
    const parsed = resolveDates(fields, startDate, skip);
    if (!parsed) continue;

    const startTime = readTime(inlineStartIsDate ? undefined : fields.start, skip);
    const durationMinutes = readMinutes(fields.duration, "duration", skip);
    const reminderMinutes = readReminder(fields, options, skip);
    const recurrence = readRecurrence(fields, parsed.date, options, skip);

    tasks.push({
      title,
      sourcePath,
      line: lineNumber,
      date: parsed.date,
      dueDate: parsed.dueDate,
      endDate: parsed.endDate,
      startTime,
      durationMinutes,
      reminderMinutes,
      priority: readPriority(body, fields.priority),
      tags: readTags(body),
      recurrence,
      status,
      stableId: buildStableId(sourcePath, line, fields.id, title, occurrence),
    });
  }

  return { tasks, skipped };
}

/**
 * Whether a single line is written as a task, with text, by the rules the parser applies — for
 * telling "not a task" apart from "a task the parser deliberately ignored" (one in a code block).
 */
export function isTaskLine(line: string): boolean {
  const match = TASK_RE.exec(stripQuoteMarkers(line));
  return match !== null && match[3].trim() !== "";
}

/** Sorts by the instant the event starts, then by identity so output is stable. */
export function compareTasks(a: CalendarTask, b: CalendarTask): number {
  const byDate = compareDates(a.date, b.date);
  if (byDate !== 0) return byDate;
  const aTime = a.startTime ?? "";
  const bTime = b.startTime ?? "";
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  return a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0;
}

/**
 * The free tier exports the tasks a user actually cares about — the next N
 * starting from today — rather than whichever N the vault happened to list first.
 */
export function selectUpcoming(tasks: CalendarTask[], limit: number, today: string): CalendarTask[] {
  const sorted = [...tasks].sort(compareTasks);
  const upcoming: CalendarTask[] = [];
  const past: CalendarTask[] = [];
  for (const task of sorted) {
    (compareDates(effectiveEnd(task), today) >= 0 ? upcoming : past).push(task);
  }
  if (upcoming.length >= limit) return upcoming.slice(0, Math.max(0, limit));
  // Top up with the most recent past tasks rather than exporting a thin calendar.
  return [...upcoming, ...past.reverse()].slice(0, Math.max(0, limit));
}

function effectiveEnd(task: CalendarTask): string {
  return task.endDate ?? task.date;
}

/**
 * Line indexes inside fenced code blocks.
 *
 * A closing fence must use the same character as its opener and be at least as
 * long (CommonMark §4.5), so a ``` line no longer closes a ```` block and a
 * ~~~ line no longer closes a ``` block. An *unterminated* fence is treated as
 * ordinary text: letting it swallow the rest of the note hid every task below a
 * stray backtick line with nothing in the report to explain it.
 */
function findFencedLines(lines: string[]): Set<number> {
  const fenced = new Set<number>();
  let open: { char: string; length: number; start: number; depth: number } | null = null;

  for (let index = 0; index < lines.length; index++) {
    const depth = quoteDepth(lines[index]);
    const line = stripQuoteMarkers(lines[index]);

    const match = FENCE_RE.exec(line);

    // A blockquote cannot survive a non-blank line at a shallower depth, so a
    // fence opened inside one ends there too. Letting it stay open — the case
    // where someone closes a callout's code block without the `>` — sent it
    // hunting for a same-depth closer arbitrarily far down the note, and every
    // real task in between was marked as code and silently deleted, with
    // nothing in the export report to explain where they went.
    if (open && open.depth > 0 && depth < open.depth && lines[index].trim() !== "") {
      // The lines it did cover are still code. Dropping the fence without
      // marking them let a task written inside a callout's code block escape
      // into the calendar as a real commitment.
      // An unquoted fence line here is almost always the close the author meant
      // to write with a `>`, so it is treated as one — otherwise it opens a stray
      // top-level fence that then hides every later callout's code block.
      const closing = match !== null && match[1][0] === open.char && match[1].length >= open.length && match[2].trim() === "";
      for (let i = open.start; i <= (closing ? index : index - 1); i++) fenced.add(i);
      open = null;
      if (closing) continue;
    }

    if (!match) continue;
    const marker = match[1];

    // A fence belongs to its blockquote. Ignoring the depth let a fence opened
    // inside a callout be closed by an unrelated top-level fence — deleting
    // every real task in between — and let a quoted ``` line inside a genuine
    // code block close it early, leaking documentation into the calendar.
    if (open && depth !== open.depth) continue;

    if (!open) {
      open = { char: marker[0], length: marker.length, start: index, depth };
      continue;
    }
    // A closing fence carries no info string.
    if (marker[0] === open.char && marker.length >= open.length && match[2].trim() === "") {
      for (let i = open.start; i <= index; i++) fenced.add(i);
      open = null;
    }
  }

  return fenced;
}

function quoteDepth(line: string): number {
  const match = /^(?:\s*>)+/.exec(line);
  return match ? (match[0].match(/>/g) ?? []).length : 0;
}

function stripQuoteMarkers(line: string): string {
  return line.replace(/^(\s*>)+\s?/, "");
}

function readStatus(marker: string): TaskStatus {
  const value = marker.toLowerCase();
  if (value === "x") return "done";
  if (value === "-") return "cancelled";
  if (value === "/") return "in-progress";
  return "todo";
}

interface Fields {
  due?: string;
  scheduled?: string;
  start?: string;
  end?: string;
  duration?: string;
  reminder?: string;
  priority?: string;
  repeat?: string;
  recurrence?: string;
  id?: string;
  /** The 🛫 date, kept apart from `start` — see readFields. */
  startDate?: string;
}

function readFields(body: string): Fields {
  const fields: Fields = {};
  for (const name of FIELD_NAMES) {
    const value = findInlineField(body, name);
    if (value !== undefined) (fields as Record<string, string>)[name] = value;
  }

  // Emoji forms win only where an explicit inline field was not given.
  fields.due ??= findEmojiDate(body, EMOJI.due);
  fields.scheduled ??= findEmojiDate(body, EMOJI.scheduled);
  // 🛫 and `[start:: …]` are two different things — a start *date* and a start
  // *time* — so they get two slots. Sharing one meant a task carrying both lost
  // its 🛫 date, and a task whose only date was the 🛫 one vanished as undated.
  fields.startDate = findEmojiDate(body, EMOJI.start);
  fields.repeat ??= findEmojiValue(body, EMOJI.recurrence);
  fields.id ??= findEmojiValue(body, EMOJI.id);

  // Legacy `@2026-08-02` shorthand, kept for notes written against 1.0.x.
  if (!fields.due) {
    const atDate = /(?:^|\s)@(\d{4}-\d{2}-\d{2})(?=\s|$)/.exec(body);
    if (atDate) fields.due = atDate[1];
  }

  return fields;
}

function resolveDates(
  fields: Fields,
  startDate: string | undefined,
  skip: (reason: SkippedTask["reason"], detail: string, fatal?: boolean) => void
): { date: string; dueDate?: string; endDate?: string } | undefined {
  const candidates: Array<[string, string | undefined]> = [
    ["scheduled", fields.scheduled],
    ["due", fields.due],
    ["start", startDate],
  ];

  const valid = new Map<string, string>();
  const invalid: Array<[string, string]> = [];
  for (const [name, value] of candidates) {
    if (value === undefined) continue;
    if (isValidDate(value)) valid.set(name, value);
    else invalid.push([name, value]);
  }

  // Scheduled means "I plan to work on it then", which is what belongs on a
  // calendar; due is the deadline and is carried into the description.
  const date = valid.get("scheduled") ?? valid.get("due") ?? valid.get("start");
  if (!date) {
    if (invalid.length > 0) {
      const [name, value] = invalid[0];
      skip("invalid-date", `"${value}" is not a real date (${name}). Use YYYY-MM-DD.`);
    } else {
      skip("no-date", "No due, scheduled, or start date found.");
    }
    return undefined;
  }

  // A typo in a date that is not the one placing the event drops that field, not
  // the task. Rejecting all three up front meant one fat-fingered deadline on a
  // task that already carried a valid scheduled date removed it from the
  // calendar entirely — the opposite of rule 3 at the top of this file.
  for (const [name, value] of invalid) {
    skip("invalid-date", `Ignored the ${name} date "${value}" — it is not a real date. The task was still exported.`, false);
  }

  // An unusable end date drops the end date, not the task: the placement date
  // is valid and the event can still be exported as a single day.
  let endDate = fields.end;
  if (endDate !== undefined && !isValidDate(endDate)) {
    skip("invalid-date", `Ignored the end date "${endDate}" — it is not a real date. The task was still exported.`, false);
    endDate = undefined;
  } else if (endDate !== undefined && compareDates(endDate, date) < 0) {
    skip("invalid-range", `Ignored the end date ${endDate} — it is before ${date}. The task was still exported.`, false);
    endDate = undefined;
  }

  const due = valid.get("due");
  const dueDate = due && due !== date ? due : undefined;
  return { date, dueDate, endDate };
}

function readTime(value: string | undefined, skip: (reason: SkippedTask["reason"], detail: string, fatal?: boolean) => void): string | undefined {
  if (value === undefined) return undefined;
  if (isValidDate(value)) return undefined;
  const normalized = normalizeTime(value);
  if (!normalized) {
    skip("invalid-time", `Ignored the start time "${value}" — use HH:mm. The task was exported as an all-day event.`, false);
    return undefined;
  }
  return normalized;
}

/**
 * The reminder gate lives here, beside the recurrence gate, rather than in the
 * ICS layer where it used to be. That layer has no way to report anything, so a
 * `[reminder:: 30m]` on a free-tier export produced no alarm and no explanation,
 * and the report cheerfully said nothing had been skipped.
 */
function readReminder(
  fields: Fields,
  options: ParseOptions,
  skip: (reason: SkippedTask["reason"], detail: string, fatal?: boolean) => void
): number | undefined {
  const minutes = readMinutes(fields.reminder, "reminder", skip);
  if (minutes === undefined) return undefined;
  if (!options.includeReminders) {
    skip("reminder-not-enabled", `No alarm was set for "${fields.reminder ?? ""}" — turn on "Reminder alarms" in settings (Pro).`, false);
    return undefined;
  }
  return minutes;
}

function readRecurrence(
  fields: Fields,
  date: string,
  options: ParseOptions,
  skip: (reason: SkippedTask["reason"], detail: string, fatal?: boolean) => void
): CalendarTask["recurrence"] {
  const text = fields.repeat ?? fields.recurrence;
  if (!text) return undefined;
  if (!options.includeRecurrence) {
    // Say so. A repeat rule that quietly does nothing, with the report claiming
    // nothing was skipped, is the worst outcome for a user who paid for it.
    skip("repeat-not-enabled", `"${text}" was not exported as a repeating event — turn on "Repeating tasks" in settings (Pro).`, false);
    return undefined;
  }

  const recurrence = parseRecurrence(text);
  if (!recurrence) {
    skip("unsupported-recurrence", `Could not translate "${text}" into a calendar repeat rule. The task was exported as a single event.`, false);
    return undefined;
  }

  // An RRULE whose BYDAY or BYMONTHDAY disagrees with DTSTART is where calendar
  // apps diverge — some show a phantom first occurrence, some drop it. Report
  // the mismatch instead of shipping a rule that means different things.
  const mismatch = describeRuleMismatch(recurrence.rrule, date);
  if (mismatch) {
    skip("unsupported-recurrence", `${mismatch} The task was exported as a single event.`, false);
    return undefined;
  }

  return recurrence;
}

function describeRuleMismatch(rrule: string, date: string): string | undefined {
  const byDay = /BYDAY=([A-Z,]+)/.exec(rrule);
  if (byDay && !byDay[1].split(",").includes(weekdayOf(date))) {
    return `"${date}" is a ${weekdayName(date)}, which the repeat rule does not include.`;
  }

  // An ordinal BYDAY — `BYDAY=1MO`, `BYDAY=-1FR` — carries a digit, so the plain
  // weekday check above cannot see it. Left unchecked, "every month on the first
  // Monday" on a task dated the third Monday shipped a rule whose first
  // occurrence some clients invent and others drop.
  const ordinalDay = /BYDAY=(-?\d)([A-Z]{2})/.exec(rrule);
  if (ordinalDay) {
    if (ordinalDay[2] !== weekdayOf(date)) {
      return `"${date}" is a ${weekdayName(date)}, which the repeat rule does not include.`;
    }
    const position = Number(ordinalDay[1]);
    const day = dayOfMonth(date);
    const [year, month] = date.split("-").map(Number);
    const nth = Math.floor((day - 1) / 7) + 1;
    const isLast = day + 7 > daysInMonth(year, month);
    if (position === -1 ? !isLast : position !== nth) {
      const described = position === -1 ? "last" : `${position}${ordinalSuffix(position)}`;
      return `The repeat rule targets the ${described} ${weekdayName(date)} of the month but the task is dated the ${day}.`;
    }
  }

  const byMonthDay = /BYMONTHDAY=(-?\d+)/.exec(rrule);
  if (byMonthDay) {
    const wanted = Number(byMonthDay[1]);
    const actual = dayOfMonth(date);
    const [year, month] = date.split("-").map(Number);
    // A negative BYMONTHDAY counts back from the end of the month. Guarding on
    // `wanted > 0` let "every month on the last" through on any date at all.
    const target = wanted > 0 ? wanted : daysInMonth(year, month) + 1 + wanted;
    if (target !== actual) {
      const described = wanted > 0 ? `day ${wanted}` : "the last day";
      return `The repeat rule targets ${described} of the month but the task is dated the ${actual}.`;
    }
  }

  return undefined;
}

function ordinalSuffix(value: number): string {
  return value === 1 ? "st" : value === 2 ? "nd" : value === 3 ? "rd" : "th";
}

function weekdayName(date: string): string {
  const names: Record<string, string> = { SU: "Sunday", MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday" };
  return names[weekdayOf(date)] ?? "day";
}

/**
 * Every pattern here depends only on module constants, so all of them are built
 * once. They used to be recompiled from a freshly interpolated template string
 * on every field of every task line — around fifty `RegExp` constructions per
 * line, which was most of the cost of parsing a vault.
 */
interface FieldPatterns {
  bracket: RegExp;
  paren: RegExp;
  bare: RegExp;
}

const FIELD_PATTERNS = new Map<string, FieldPatterns>(
  FIELD_NAMES.map((name) => [
    name,
    {
      // `[^\]]*(?:\]\][^\]]*)*` is unambiguous, so a long line cannot backtrack
      // quadratically the way a nested `(?:\[\[…\]\]|[^\]])+` alternation did.
      bracket: new RegExp(`\\[${name}::\\s*([^\\]]*(?:\\]\\][^\\]]*)*)\\]`, "i"),
      paren: new RegExp(`\\(${name}::\\s*([^)]*)\\)`, "i"),
      // `u` matters: bareFieldPattern embeds a class of astral emoji code points,
      // and without it that class degrades to lone UTF-16 surrogates — matching
      // any character sharing a lead surrogate and none of the 🆔/⛔ family.
      bare: new RegExp(bareFieldPattern(name), "iu"),
    },
  ])
);

function findInlineField(body: string, name: string): string | undefined {
  const patterns = FIELD_PATTERNS.get(name);
  if (!patterns) return undefined;

  const bracket = patterns.bracket.exec(body);
  if (bracket) return normalizeFieldValue(bracket[1]);

  const paren = patterns.paren.exec(body);
  if (paren) return normalizeFieldValue(paren[1]);

  const bare = patterns.bare.exec(body);
  if (bare) return normalizeFieldValue(bare[1]);

  return undefined;
}

/**
 * A single-token field stops at the first space, so trailing tags, block ids,
 * emoji, and prose stay out of the value. A free-text field runs on until the
 * next field, bracket, tag, block id, or emoji.
 */
function bareFieldPattern(name: string): string {
  if (SINGLE_TOKEN_FIELDS.includes(name)) {
    // The first alternative keeps `start:: 7:00 pm` whole — cut at the space,
    // `7:00` validated on its own and a 7 PM dinner exported at 7 AM silently.
    // It is deliberately time-shaped: a looser rule read the ordinary word "am"
    // in `due:: 2026-08-02 am I ready` as a meridiem and dropped the task.
    return `(?:^|\\s)${name}::\\s*(\\d{1,2}(?::\\d{2}){0,2}\\s*[AaPp]\\.?[Mm]\\.?(?=\\s|$)|\\[\\[[^\\]]+\\]\\]|\\S+)`;
  }
  // Stops at the next field (bare or bracketed), a tag, a block id, or an emoji.
  // A bare `(` no longer stops it, so a parenthetical inside a repeat rule does
  // not truncate the rule.
  //
  // `\p{Extended_Pictographic}` as well as the Tasks vocabulary: before these
  // patterns gained the `u` flag, the emoji class silently matched lone
  // surrogates and so happened to stop at any emoji sharing a lead surrogate
  // with one of ours. Fixing the flag would otherwise have narrowed that to the
  // Tasks emoji alone, and `🔁 every week 🎉 party` would run the celebration
  // into the repeat rule and fail to translate it.
  return `(?:^|\\s)${name}::\\s*(.+?)(?=\\s+[A-Za-z][A-Za-z-]*::|\\s*[\\[(][A-Za-z][A-Za-z-]*::|\\s*\\[|\\s+#|\\s+\\^[A-Za-z0-9-]+\\s*$|\\s*[${ALL_EMOJI}]|\\s*\\p{Extended_Pictographic}|$)`;
}

/**
 * Unwraps a Dataview date link and trims. Handles the full link form —
 * `[[dates/2026-08-02|Aug 2]]` — by dropping the folder path and the alias,
 * which otherwise came through as a value no date parser could read.
 */
function normalizeFieldValue(value: string): string | undefined {
  let trimmed = value.trim();
  const link = /^\[\[(.+?)\]\]$/.exec(trimmed);
  if (link) {
    const target = link[1].split("|")[0];
    trimmed = (target.split("/").pop() ?? target).trim();
  }
  return trimmed || undefined;
}

const EMOJI_DATE_PATTERNS = new Map<string, RegExp>(
  [EMOJI.due, EMOJI.scheduled, EMOJI.start].map((emoji) => [emoji, new RegExp(`[${emoji}]\\uFE0F?\\s*(\\d{4}-\\d{2}-\\d{2})`, "u")])
);

const EMOJI_VALUE_PATTERNS = new Map<string, RegExp>([
  // Stops at a bracket or at ANY emoji, not only the Tasks vocabulary: a
  // decorative `🎉` after `🔁 every week` used to be read as part of the cadence,
  // which made the whole rule untranslatable and downgraded the event to a one-off.
  [EMOJI.recurrence, new RegExp(`[${EMOJI.recurrence}]\\uFE0F?\\s*([^\\[\\p{Extended_Pictographic}]+)`, "u")],
  [EMOJI.id, new RegExp(`[${EMOJI.id}]\\uFE0F?\\s*(\\S+)`, "u")],
]);

function findEmojiDate(body: string, emoji: string): string | undefined {
  const match = EMOJI_DATE_PATTERNS.get(emoji)?.exec(body);
  return match ? match[1] : undefined;
}

function findEmojiValue(body: string, emoji: string): string | undefined {
  const match = EMOJI_VALUE_PATTERNS.get(emoji)?.exec(body);
  return match ? match[1].trim() || undefined : undefined;
}

/**
 * Accepts `45`, `45m`, `1h`, `1.5h`, `1h30m`, `1 hour 30 minutes`, and the
 * European decimal comma (`1,5h`). Anything only partly understood is reported
 * rather than silently read as a much shorter time.
 */
function readMinutes(
  value: string | undefined,
  name: string,
  skip: (reason: SkippedTask["reason"], detail: string, fatal?: boolean) => void
): number | undefined {
  if (!value) return undefined;
  const text = stripTrailingNotes(value)
    .toLowerCase()
    // A comma between digits is a decimal point, not a separator.
    .replace(/(\d),(\d)/g, "$1.$2");
  if (!text) return undefined;

  const token = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m)?/y;
  const separator = /[\s,]+/y;
  let total = 0;
  let index = 0;
  let seen = false;

  while (index < text.length) {
    separator.lastIndex = index;
    if (separator.exec(text)) {
      index = separator.lastIndex;
      continue;
    }

    token.lastIndex = index;
    const match = token.exec(text);
    if (!match || match[0].length === 0) {
      skip("invalid-duration", `Ignored the ${name} "${value}" — try 45m, 1h, or 1h30m. The task was still exported.`, false);
      return undefined;
    }
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return undefined;
    const unit = match[2] ?? "m";
    total += unit.startsWith("d") ? amount * 1440 : unit.startsWith("h") ? amount * 60 : amount;
    seen = true;
    index = token.lastIndex;
  }

  if (!seen) return undefined;
  const rounded = Math.round(total);
  if (rounded <= 0) return undefined;
  if (rounded > MAX_DURATION_MINUTES) {
    skip("invalid-duration", `Ignored the ${name} "${value}" — longer than a year. The task was still exported.`, false);
    return undefined;
  }
  return rounded;
}

function readPriority(body: string, field: string | undefined): number | undefined {
  if (field) {
    // Map, not an object: `[priority:: constructor]` resolved up the prototype
    // chain to a function and was emitted as the PRIORITY value.
    const word = PRIORITY_WORDS.get(field.trim().toLowerCase());
    if (word !== undefined) return word;
    const numeric = Number.parseInt(field, 10);
    if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 9) return numeric;
  }
  for (const [emoji, value] of PRIORITY_EMOJI) {
    if (body.includes(emoji)) return value;
  }
  return undefined;
}


function readTags(body: string): string[] {
  const tags = new Set<string>();
  const re = new RegExp(TAG_PATTERN, "gu");
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) tags.add(match[1]);
  return [...tags];
}

function cleanTitle(body: string): string {
  let text = body.replace(BLOCK_ID_RE, "");

  // Inline fields, bracketed and parenthesised.
  text = text
    .replace(new RegExp(`\\[(?:${FIELD_NAMES.join("|")})::\\s*[^\\]]*(?:\\]\\][^\\]]*)*\\]`, "gi"), " ")
    .replace(new RegExp(`\\((?:${FIELD_NAMES.join("|")})::[^)]*\\)`, "gi"), " ");

  // Bare fields, stripped with the same rules used to read them, so a
  // single-token field leaves the prose that follows it in the title.
  for (const name of FIELD_NAMES) {
    text = text.replace(new RegExp(bareFieldPattern(name), "giu"), " ");
  }

  return text
    // Priority emoji carry no payload.
    .replace(new RegExp(`[${PRIORITY_CHARS}]\\uFE0F?`, "gu"), " ")
    // Date emoji take exactly one date with them, so prose after the date — the
    // one thing a greedy rule would eat — survives.
    .replace(new RegExp(`[${DATE_EMOJI}]\\uFE0F?\\s*\\d{4}-\\d{2}-\\d{2}`, "gu"), " ")
    // Id and depends-on take one token; a repeat rule runs to the next field.
    .replace(new RegExp(`[${EMOJI.id}${EMOJI.dependsOn}]\\uFE0F?\\s*\\S+`, "gu"), " ")
    .replace(new RegExp(`[${EMOJI.recurrence}]\\uFE0F?[^${ALL_EMOJI}\\[]*`, "gu"), " ")
    .replace(new RegExp(`[${ALL_EMOJI}]\\uFE0F?`, "gu"), " ")
    .replace(/(?:^|\s)@\d{4}-\d{2}-\d{2}(?=\s|$)/g, " ")
    // The same tag shape readTags uses, so a tag is never half-removed: the
    // ASCII-only version left `é` behind in the title of every `#café` task.
    .replace(new RegExp(TAG_PATTERN, "gu"), " ")
    // Links become their display text: [[note|Alias]], [[note]], [text](url).
    // The url pattern allows one level of nested parens, as Wikipedia links have.
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function buildStableId(sourcePath: string, line: string, explicitId: string | undefined, title: string, occurrence: number): string {
  // 1. An id the user controls survives everything, including moving the note.
  if (explicitId) return explicitId;

  // 2. An Obsidian block id survives edits and line moves within the note.
  const blockId = BLOCK_ID_RE.exec(line);
  if (blockId) return `${sourcePath}#^${blockId[1]}`;

  // 3. Otherwise hash path + title + occurrence. Deliberately excludes the line
  //    number and the date, so inserting a line above a task or rescheduling it
  //    updates the event in place instead of creating a duplicate.
  return `h${hash64(`${sourcePath} ${title} ${occurrence}`)}`;
}

/**
 * A copy that shares nothing with the string it came from.
 *
 * `split("")`/`join("")` is deliberate rather than clever: every other way of
 * writing this can be optimised back into a view of the parent string, which is
 * exactly what has to be avoided. The inputs are at most a couple of hundred
 * characters, so the cost does not matter.
 */
function flatten(value: string): string {
  return value.split("").join("");
}

/** 64-bit FNV-1a as two 32-bit lanes — 32 bits collides at vault scale. */
export function hash64(input: string): string {
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    high ^= code;
    high = Math.imul(high, 0x01000193);
    low ^= code + i;
    low = Math.imul(low, 0x85ebca6b);
  }
  return (high >>> 0).toString(16).padStart(8, "0") + (low >>> 0).toString(16).padStart(8, "0");
}
