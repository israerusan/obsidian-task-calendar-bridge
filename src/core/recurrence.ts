import { stripTrailingNotes } from "./text";
import type { Recurrence } from "./types";

/**
 * Translates the Obsidian Tasks plugin's recurrence phrases into an RFC 5545
 * RRULE. Deliberately a documented subset: anything not understood returns
 * undefined so the caller can report it instead of exporting a wrong rule.
 * A silently mis-scheduled repeating event is worse than a reported skip.
 */

// Maps, not plain objects: `UNIT_FREQ["constructor"]` resolved up the prototype
// chain to a function and produced `RRULE:FREQ=function Object() {…}`, which
// makes the entire calendar file unparseable.
const WEEKDAYS = new Map<string, string>([
  ["sunday", "SU"], ["sun", "SU"],
  ["monday", "MO"], ["mon", "MO"],
  ["tuesday", "TU"], ["tue", "TU"], ["tues", "TU"],
  ["wednesday", "WE"], ["wed", "WE"],
  ["thursday", "TH"], ["thu", "TH"], ["thur", "TH"], ["thurs", "TH"],
  ["friday", "FR"], ["fri", "FR"],
  ["saturday", "SA"], ["sat", "SA"],
]);

const UNIT_FREQ = new Map<string, string>([
  ["day", "DAILY"], ["days", "DAILY"],
  ["week", "WEEKLY"], ["weeks", "WEEKLY"],
  ["month", "MONTHLY"], ["months", "MONTHLY"],
  ["year", "YEARLY"], ["years", "YEARLY"],
]);

export function parseRecurrence(input: string): Recurrence | undefined {
  // A trailing tag, block id, or parenthetical is a comment on the task, not
  // part of the cadence: `🔁 every week on Monday #work` used to be reported as
  // an untranslatable rule and silently downgraded to a one-off event.
  const source = stripTrailingNotes(input);
  const text = source
    .toLowerCase()
    // "when done" changes when the *next* task is created, not the calendar
    // cadence, so it is stripped rather than treated as unsupported.
    .replace(/\bwhen\s+done\b/g, "")
    .trim();
  if (!text) return undefined;

  const body = text.replace(/^every\s*/, "").trim();
  if (!body) return undefined;

  if (/^weekday(s)?$/.test(body)) {
    return { rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", source };
  }

  // "every 2 weeks on monday, friday" / "every month on the 15th" / "every monday"
  const match = /^(?:(\d+)\s+)?([a-z]+)(?:\s+(.*))?$/.exec(body);
  if (!match) return undefined;

  const interval = match[1] ? Number(match[1]) : 1;
  if (!Number.isFinite(interval) || interval < 1 || interval > 999) return undefined;
  const unitWord = match[2];
  const rest = (match[3] ?? "").trim();

  // "every monday" — a bare weekday means weekly on that day.
  const bareWeekday = WEEKDAYS.get(unitWord);
  if (bareWeekday && !match[1]) {
    if (rest) return undefined;
    return { rrule: `FREQ=WEEKLY;BYDAY=${bareWeekday}`, source };
  }

  const freq = UNIT_FREQ.get(unitWord);
  if (!freq) return undefined;

  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);

  if (rest) {
    const modifier = parseModifier(freq, rest);
    if (!modifier) return undefined;
    parts.push(modifier);
  }

  return { rrule: parts.join(";"), source };
}

function parseModifier(freq: string, rest: string): string | undefined {
  const cleaned = rest.replace(/^on\s+(the\s+)?/, "").trim();
  if (!cleaned) return undefined;

  if (freq === "WEEKLY") {
    const days = cleaned
      .split(/\s*(?:,|and)\s*/)
      .map((day) => WEEKDAYS.get(day.trim()))
      .filter((day): day is string => day !== undefined);
    if (days.length === 0) return undefined;
    // Preserve calendar order and drop duplicates.
    const order = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    const unique = order.filter((day) => days.includes(day));
    return `BYDAY=${unique.join(",")}`;
  }

  if (freq === "MONTHLY") {
    if (/^last(\s+day)?$/.test(cleaned)) return "BYMONTHDAY=-1";
    const day = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(cleaned);
    if (day) {
      const value = Number(day[1]);
      if (value >= 1 && value <= 31) return `BYMONTHDAY=${value}`;
    }
    return undefined;
  }

  // Daily and yearly modifiers are not translated; report rather than guess.
  return undefined;
}
