import { addDays, compactDate, formatFloatingDateTime, formatUtcStamp, formatZonedDateTimeAsUtc } from "./dates";
import type { CalendarTask, IcsOptions } from "./types";

export interface IcsResult {
  ics: string;
  eventCount: number;
  /** Tasks dropped because another task already claimed the same identity. */
  duplicateIds: CalendarTask[];
}

const UID_DOMAIN = "task-calendar-bridge";

export function generateIcsCalendar(tasks: CalendarTask[], options: IcsOptions, now: Date = new Date()): IcsResult {
  const stamp = formatUtcStamp(now);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${escapeIcsText(options.productId)}`,
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcsText(options.calendarName)}`,
  ];
  // No METHOD: it declares an iTIP scheduling message, which requires an
  // ORGANIZER this calendar has no business inventing (RFC 5545 §3.7.2).
  if (options.timeMode === "zoned" && options.timeZone) {
    lines.push(`X-WR-TIMEZONE:${escapeIcsText(options.timeZone)}`);
  }

  const seen = new Set<string>();
  const duplicateIds: CalendarTask[] = [];
  let eventCount = 0;

  for (const task of tasks) {
    const uid = createUid(task);
    if (seen.has(uid)) {
      duplicateIds.push(task);
      continue;
    }
    seen.add(uid);
    lines.push(...taskToEventLines(task, options, stamp, uid));
    eventCount++;
  }

  lines.push("END:VCALENDAR");
  // Fold every content line to the RFC 5545 §3.1 75-octet limit before joining.
  return { ics: `${lines.map(foldIcsLine).join("\r\n")}\r\n`, eventCount, duplicateIds };
}

/**
 * UID is a TEXT value that has to survive verbatim through every calendar
 * client, so the stable id is hashed into an opaque token rather than embedding
 * a vault path with spaces, commas, and slashes in it.
 */
export function createUid(task: CalendarTask): string {
  return `tcb-${hashToken(task.stableId)}@${UID_DOMAIN}`;
}

function taskToEventLines(task: CalendarTask, options: IcsOptions, stamp: string, uid: string): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${escapeIcsText(buildSummary(task))}`,
  ];

  const timed = Boolean(task.startTime);
  if (timed && task.startTime) {
    const start = formatDateTime(task.date, task.startTime, options, Boolean(task.recurrence));
    lines.push(`DTSTART${start.prefix}:${start.value}`);

    const minutes = task.durationMinutes && task.durationMinutes > 0 ? task.durationMinutes : options.defaultDurationMinutes;
    if (task.endDate && task.endDate !== task.date) {
      // A multi-day timed task runs to the same clock time (plus its duration)
      // on the end date. Previously the end date was silently discarded.
      const end = addMinutes(task.endDate, task.startTime, minutes);
      const formatted = formatDateTime(end.date, end.time, options, Boolean(task.recurrence));
      lines.push(`DTEND${formatted.prefix}:${formatted.value}`);
    } else {
      lines.push(`DURATION:PT${minutes}M`);
    }
  } else {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(task.date)}`);
    // DTEND is exclusive for all-day events (RFC 5545 §3.8.2.2).
    lines.push(`DTEND;VALUE=DATE:${compactDate(addDays(task.endDate ?? task.date, 1))}`);
  }

  if (task.recurrence) lines.push(`RRULE:${task.recurrence.rrule}`);

  // An all-day task should not blank out the user's whole day as busy.
  lines.push(`TRANSP:${timed ? "OPAQUE" : "TRANSPARENT"}`);
  // VEVENT only accepts TENTATIVE, CONFIRMED, or CANCELLED — COMPLETED is a
  // VTODO status and made the file invalid.
  lines.push(`STATUS:${task.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`);
  if (task.status === "done") lines.push("X-OBSIDIAN-TASK-COMPLETED:TRUE");

  if (task.priority !== undefined) lines.push(`PRIORITY:${task.priority}`);

  const categories = buildCategories(task, options);
  if (categories.length > 0) lines.push(`CATEGORIES:${categories.map(escapeIcsText).join(",")}`);

  const url = buildObsidianUri(task, options.vaultName);
  lines.push(`DESCRIPTION:${escapeIcsText(buildDescription(task, url))}`);
  // URL is a URI value, not TEXT: escaping it would corrupt the link.
  if (url) lines.push(`URL:${url}`);

  lines.push(...buildAlarm(task, options, timed));
  lines.push("END:VEVENT");
  return lines;
}

function buildSummary(task: CalendarTask): string {
  if (task.status === "done") return `\u2714 ${task.title}`;
  if (task.status === "cancelled") return `\u2716 ${task.title}`;
  return task.title;
}

function buildCategories(task: CalendarTask, options: IcsOptions): string[] {
  const categories: string[] = [];
  if (options.exportTags) categories.push(...task.tags);
  if (task.status === "done") categories.push("Completed");
  return categories;
}

function buildDescription(task: CalendarTask, url: string | undefined): string {
  const parts: string[] = [];
  if (task.dueDate) parts.push(`Due: ${task.dueDate}`);
  if (task.recurrence) parts.push(`Repeats: ${task.recurrence.source}`);
  parts.push(`Source: ${task.sourcePath} (line ${task.line})`);
  if (url) parts.push(url);
  return parts.join("\n");
}

/**
 * `obsidian://open?vault=<vault>&file=<vault-relative path>`.
 *
 * The 1.0.x form used `path=`, which expects an absolute filesystem path, and
 * appended `#L<line>`, which the URI scheme has no concept of — so every
 * generated link was dead. Without a vault name there is nothing reliable to
 * link to, so the link is omitted rather than emitted broken.
 */
export function buildObsidianUri(task: CalendarTask, vaultName: string): string | undefined {
  if (!vaultName) return undefined;
  const file = task.sourcePath.replace(/\.md$/i, "");
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
}

function buildAlarm(task: CalendarTask, options: IcsOptions, timed: boolean): string[] {
  if (!options.includeReminders) return [];
  if (!task.reminderMinutes || task.reminderMinutes <= 0) return [];

  let trigger: string;
  if (timed) {
    trigger = `-PT${task.reminderMinutes}M`;
  } else {
    // DTSTART is midnight for an all-day event, so a plain `-PT30M` alarm fires
    // at 23:30 the night before. Offset from the configured reminder time instead.
    const [hours, minutes] = options.allDayReminderTime.split(":").map(Number);
    const offset = hours * 60 + minutes - task.reminderMinutes;
    trigger = offset >= 0 ? `PT${offset}M` : `-PT${Math.abs(offset)}M`;
  }

  return [
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeIcsText(task.title)}`,
    `TRIGGER:${trigger}`,
    "END:VALARM",
  ];
}

function formatDateTime(date: string, time: string, options: IcsOptions, recurring: boolean): { prefix: string; value: string } {
  // A repeating event pinned to a UTC instant drifts by an hour the moment the
  // zone crosses a DST boundary — a 09:00 weekly standup becomes 08:00 in
  // November. Recurrence has to stay wall-clock, which is what users mean.
  if (!recurring && options.timeMode === "zoned" && options.timeZone) {
    const utc = formatZonedDateTimeAsUtc(date, time, options.timeZone);
    // Emitting the resolved UTC instant avoids shipping VTIMEZONE rules that
    // would go stale; clients render it in the viewer's zone correctly.
    if (utc) return { prefix: "", value: utc };
  }
  return { prefix: "", value: formatFloatingDateTime(date, time) };
}

function addMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const [hours, mins] = time.split(":").map(Number);
  const total = hours * 60 + mins + minutes;
  const dayShift = Math.floor(total / 1440);
  const remainder = ((total % 1440) + 1440) % 1440;
  return {
    date: dayShift === 0 ? date : addDays(date, dayShift),
    time: `${String(Math.floor(remainder / 60)).padStart(2, "0")}:${String(remainder % 60).padStart(2, "0")}`,
  };
}

/**
 * Folds a single content line so no line exceeds 75 octets (RFC 5545 §3.1).
 * Continuation lines are prefixed with a single space, which counts toward the
 * limit. Folds on UTF-8 byte boundaries by iterating code points, so a
 * multi-byte character is never split.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const chBytes = encoder.encode(ch).length;
    if (bytes + chBytes > 75) {
      out.push(current);
      // Continuation lines start with a space that counts as one octet.
      current = ` ${ch}`;
      bytes = 1 + chBytes;
    } else {
      current += ch;
      bytes += chBytes;
    }
  }
  out.push(current);
  return out.join("\r\n");
}

export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n")
    // RFC 5545 section 3.1 forbids control characters in a property value. One
    // pasted into a task title made the whole file unimportable, so they are
    // dropped here rather than smuggled through to the calendar app.
    // eslint-disable-next-line no-control-regex -- matching control characters is the point: they are illegal in an ICS value and must be removed
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function hashToken(input: string): string {
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
