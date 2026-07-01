export interface CalendarTask {
  title: string;
  sourcePath: string;
  line: number;
  dueDate: string;
  endDate?: string;
  startTime?: string;
  durationMinutes?: number;
  reminderMinutes?: number;
  completed: boolean;
  raw: string;
}

export interface ParseOptions {
  includeCompleted: boolean;
}

export interface TierOptions {
  isPro: boolean;
  maxFreeTasks: number;
}

export interface IcsOptions {
  calendarName: string;
  productId: string;
  includeReminders: boolean;
  defaultDurationMinutes: number;
}

const TASK_RE = /^\s*[-*+]\s+\[([ xX])]\s+(.+)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

export function parseTasksFromMarkdown(markdown: string, sourcePath: string, options: ParseOptions): CalendarTask[] {
  const tasks: CalendarTask[] = [];
  const lines = markdown.split(/\r?\n/);

  lines.forEach((line, index) => {
    const match = line.match(TASK_RE);
    if (!match) return;

    const completed = match[1].toLowerCase() === "x";
    if (completed && !options.includeCompleted) return;

    const body = match[2].trim();
    const dueDate = findDueDate(body);
    if (!dueDate) return;

    const startTime = findInlineField(body, "start");
    const endDate = findInlineField(body, "end");
    const duration = findInlineField(body, "duration");
    const reminder = findInlineField(body, "reminder");

    tasks.push({
      title: cleanTaskTitle(body),
      sourcePath,
      line: index + 1,
      dueDate,
      endDate: endDate && DATE_RE.test(endDate) ? endDate : undefined,
      startTime: startTime && TIME_RE.test(startTime) ? startTime : undefined,
      durationMinutes: duration ? parseDurationMinutes(duration) : undefined,
      reminderMinutes: reminder ? parseDurationMinutes(reminder) : undefined,
      completed,
      raw: line,
    });
  });

  return tasks;
}

export function filterTasksForTier(tasks: CalendarTask[], options: TierOptions): CalendarTask[] {
  if (options.isPro) return tasks;
  return tasks.slice(0, Math.max(0, options.maxFreeTasks));
}

export function generateIcsCalendar(tasks: CalendarTask[], options: IcsOptions): string {
  const now = formatDateTimeUtc(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${escapeIcsText(options.productId)}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(options.calendarName)}`,
  ];

  for (const task of tasks) {
    lines.push(...taskToEventLines(task, options, now));
  }

  lines.push("END:VCALENDAR");
  // Fold every content line to the RFC 5545 §3.1 75-octet limit before joining.
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

/**
 * Folds a single content line so no line exceeds 75 octets (RFC 5545 §3.1).
 * Continuation lines are prefixed with a single space, which counts toward the
 * limit. Folds on UTF-8 byte boundaries by iterating code points, so a
 * multi-byte character is never split.
 */
function foldIcsLine(line: string): string {
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

export function createStableUid(task: CalendarTask): string {
  return `${fnv1a(`${task.sourcePath}:${task.line}:${task.title}:${task.dueDate}`)}@task-calendar-bridge`;
}

function taskToEventLines(task: CalendarTask, options: IcsOptions, stamp: string): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${createStableUid(task)}`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${escapeIcsText(task.title)}`,
    `DESCRIPTION:${escapeIcsText(`Source: obsidian://open?path=${encodeURIComponent(`${task.sourcePath}#L${task.line}`)}`)}`,
    `STATUS:${task.completed ? "COMPLETED" : "CONFIRMED"}`,
  ];

  if (task.startTime) {
    lines.push(`DTSTART:${formatLocalDateTime(task.dueDate, task.startTime)}`);
    if (task.durationMinutes && task.durationMinutes > 0) {
      lines.push(`DURATION:PT${task.durationMinutes}M`);
    } else {
      lines.push(`DURATION:PT${options.defaultDurationMinutes}M`);
    }
  } else {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(task.dueDate)}`);
    const exclusiveEnd = task.endDate ? addDays(task.endDate, 1) : addDays(task.dueDate, 1);
    lines.push(`DTEND;VALUE=DATE:${compactDate(exclusiveEnd)}`);
  }

  if (options.includeReminders && task.reminderMinutes && task.reminderMinutes > 0) {
    lines.push("BEGIN:VALARM", `ACTION:DISPLAY`, `DESCRIPTION:${escapeIcsText(task.title)}`, `TRIGGER:-PT${task.reminderMinutes}M`, "END:VALARM");
  }

  lines.push("END:VEVENT");
  return lines;
}

function findDueDate(body: string): string | undefined {
  const explicit = findInlineField(body, "due");
  if (explicit && DATE_RE.test(explicit)) return explicit;
  const emoji = body.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
  if (emoji) return emoji[1];
  const atDate = body.match(/(?:^|\s)@(\d{4}-\d{2}-\d{2})(?:\s|$)/);
  if (atDate) return atDate[1];
  return undefined;
}

function findInlineField(body: string, name: string): string | undefined {
  const bracket = new RegExp(`\\[${name}::\\s*([^\\]]+)\\]`, "i").exec(body);
  if (bracket) return bracket[1].trim();
  const bare = new RegExp(`(?:^|\\s)${name}::\\s*([^\\s]+)`, "i").exec(body);
  if (bare) return bare[1].trim();
  return undefined;
}

function cleanTaskTitle(body: string): string {
  return body
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, "")
    .replace(/\[(due|start|end|duration|reminder)::[^\]]+\]/gi, "")
    .replace(/(?:^|\s)(due|start|end|duration|reminder)::\s*\S+/gi, "")
    .replace(/(?:^|\s)@\d{4}-\d{2}-\d{2}(?:\s|$)/g, " ")
    .replace(/#[A-Za-z0-9_/-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDurationMinutes(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(\d+)(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2] ?? "m";
  return unit.startsWith("h") ? amount * 60 : amount;
}

function compactDate(date: string): string {
  return date.replace(/-/g, "");
}

function formatLocalDateTime(date: string, time: string): string {
  return `${compactDate(date)}T${time.replace(":", "")}00`;
}

function formatDateTimeUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function escapeIcsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
