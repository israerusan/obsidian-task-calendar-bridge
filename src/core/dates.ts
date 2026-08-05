/**
 * Date and time helpers. Everything here validates real calendar values —
 * `2026-99-99` and `29:75` are shape-valid but must never reach an ICS file,
 * because a calendar app rejects the whole import when one DTSTART is illegal.
 */

const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_SHAPE = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([ap])\.?m\.?$|^(\d{1,2}):(\d{2})(?::(\d{2}))?$/i;

/** True only for a real Gregorian date, leap years included. */
export function isValidDate(value: string): boolean {
  const match = DATE_SHAPE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Date.UTC maps years 0-99 onto 1900+year, so `0026-08-01` would silently
  // become 1926 and put DTEND 1900 years after DTSTART.
  if (year < 1000) return false;
  // The exclusive all-day DTEND is this date plus one day, so 9999-12-31 emitted
  // `DTEND;VALUE=DATE:100000101` — a nine-digit value that is not an RFC 5545
  // DATE (`date-fullyear = 4DIGIT`) and voids the whole file. Only that one day
  // overflows; rejecting the whole of 9999 turned a working date into a reported
  // failure with a message that was not true of it.
  if (year > 9999) return false;
  if (value === "9999-12-31") return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** RFC 5545 two-letter weekday code for a `YYYY-MM-DD` date. */
export function weekdayOf(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return WEEKDAY_CODES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

export function dayOfMonth(date: string): number {
  return Number(date.split("-")[2]);
}

/**
 * Normalises `9:30`, `09:30:00`, `7:00 pm`, and `7pm` to 24-hour `HH:mm`.
 * Returns undefined when out of range — a value this cannot read must be
 * reported, never truncated to the part it happens to understand.
 */
export function normalizeTime(value: string): string | undefined {
  const match = TIME_SHAPE.exec(value.trim());
  if (!match) return undefined;

  const meridiem = match[4]?.toLowerCase();
  let hours = Number(meridiem ? match[1] : match[5]);
  const minutes = Number((meridiem ? match[2] : match[6]) ?? 0);
  const seconds = Number((meridiem ? match[3] : match[7]) ?? 0);

  if (meridiem) {
    if (hours < 1 || hours > 12) return undefined;
    if (meridiem === "a") hours = hours === 12 ? 0 : hours;
    else hours = hours === 12 ? 12 : hours + 12;
  }

  if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
  return `${pad2(hours)}:${pad2(minutes)}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function compactDate(date: string): string {
  return date.replace(/-/g, "");
}

/** `2026-07-04` + `09:30` -> `20260704T093000` (floating local wall time). */
export function formatFloatingDateTime(date: string, time: string): string {
  return `${compactDate(date)}T${time.replace(":", "")}00`;
}

export function formatUtcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Converts a wall-clock time in an IANA zone to the matching UTC instant,
 * e.g. `2026-07-04 09:30` in `America/New_York` -> `20260704T133000Z`.
 *
 * Uses Intl rather than a bundled tz database, so DST transitions stay correct
 * without shipping (or ever having to refresh) VTIMEZONE rules.
 * Returns undefined when the zone is not recognised by the runtime.
 */
export function formatZonedDateTimeAsUtc(date: string, time: string, timeZone: string): string | undefined {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);

  // Probe the offsets a day either side of the wall time rather than deriving
  // them from the wall time read as UTC. That shortcut made `before` mean the
  // pre-transition offset only in zones west of UTC; east of UTC it picked up
  // the post-transition offset, and a spring-forward gap resolved an hour
  // BACKWARD — a later clock time producing an earlier instant.
  const before = zoneOffsetMinutes(wallAsUtc - DAY_MS, timeZone);
  const after = zoneOffsetMinutes(wallAsUtc + DAY_MS, timeZone);
  if (before === undefined || after === undefined) return undefined;

  const candidateA = wallAsUtc - before * 60_000;
  const candidateB = wallAsUtc - after * 60_000;
  const aValid = zoneOffsetMinutes(candidateA, timeZone) === before;
  const bValid = zoneOffsetMinutes(candidateB, timeZone) === after;

  // Ambiguous (autumn fall-back): the wall time happens twice. Take the earlier
  // instant, which is what Temporal, dateutil, and calendar clients all do.
  if (aValid && bValid) return formatUtcStamp(new Date(Math.min(candidateA, candidateB)));
  if (aValid) return formatUtcStamp(new Date(candidateA));
  if (bValid) return formatUtcStamp(new Date(candidateB));

  // Neither is valid: the wall time falls in a spring-forward gap and does not
  // exist. The pre-transition offset lands just after the gap, so the event
  // shifts forward — the convention every calendar client follows.
  return formatUtcStamp(new Date(candidateA));
}

const DAY_MS = 86_400_000;

/**
 * One formatter per zone, not one per call.
 *
 * Deriving a VTIMEZONE probes the zone several hundred times, and constructing
 * an Intl.DateTimeFormat is by far the most expensive part of doing so.
 * `null` records a zone the runtime rejected, so it is not retried.
 */
const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = ZONE_FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    formatter = null;
  }
  ZONE_FORMATTERS.set(timeZone, formatter);
  return formatter;
}

/** Minutes the zone is ahead of UTC at the given instant (e.g. -240 for EDT). */
export function zoneOffsetMinutes(utcMs: number, timeZone: string): number | undefined {
  const formatter = zoneFormatter(timeZone);
  if (!formatter) return undefined;
  const parts = formatter.formatToParts(new Date(utcMs));

  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  const hour = read("hour");
  const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), hour === 24 ? 0 : hour, read("minute"), read("second"));
  if (!Number.isFinite(asUtc)) return undefined;
  return Math.round((asUtc - utcMs) / 60_000);
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * "just now", "3 hours ago", "12 days ago" — empty when the stamp is unusable.
 *
 * "Is my calendar up to date?" is the whole question for a file-based calendar
 * bridge. The export timestamp was recorded on every run and shown nowhere, so
 * a count from three weeks ago survived a restart and read as a fresh one.
 */
export function describeAge(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  // A clock adjustment can put the stamp slightly in the future; that is not
  // worth telling anyone about.
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Today in the local zone as `YYYY-MM-DD` (not UTC — "today" is a wall-clock idea). */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
