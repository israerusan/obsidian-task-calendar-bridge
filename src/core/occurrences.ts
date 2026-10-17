import { addDays, compareDates, dayOfMonth, daysInMonth, isValidDate, weekdayOf } from "./dates";

/**
 * Which days a repeat rule lands on, for showing the calendar inside the vault.
 *
 * The exporter never needs this: it writes the RRULE and lets the calendar app expand it. The
 * in-vault calendar view does, because a weekly standup that only appears on its first Monday
 * is a preview that disagrees with the calendar the user is about to subscribe to.
 *
 * Deliberately limited to the RRULE subset `parseRecurrence` emits — FREQ with INTERVAL, a
 * weekly BYDAY list, a monthly BYMONTHDAY or ordinal BYDAY. Anything else answers "only on its
 * start date" rather than guessing, the same rule the parser follows. WKST is the RFC 5545
 * default, Monday, because the exporter never writes one.
 */

interface Rule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  /** Plain weekday codes for WEEKLY, `MO`..`SU`. */
  weekdays?: string[];
  /** A monthly ordinal weekday: `1MO` is the first Monday, `-1FR` the last Friday. */
  ordinal?: { position: number; weekday: string };
  /** A monthly day, or -1 for the last day of the month. */
  monthDay?: number;
}

const FREQS = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const WEEKDAY_CODES = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

/** Parses the subset this plugin writes. Undefined for anything else. */
export function readRule(rrule: string): Rule | undefined {
  const parts = new Map<string, string>();
  for (const piece of rrule.split(";")) {
    const [key, value] = piece.split("=");
    if (!key || value === undefined) return undefined;
    parts.set(key.toUpperCase(), value.toUpperCase());
  }

  const freq = parts.get("FREQ");
  if (!freq || !FREQS.has(freq)) return undefined;
  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1) return undefined;
  const rule: Rule = { freq: freq as Rule["freq"], interval };

  for (const key of parts.keys()) {
    if (!["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY"].includes(key)) return undefined;
  }

  const byDay = parts.get("BYDAY");
  if (byDay) {
    if (rule.freq === "WEEKLY") {
      const days = byDay.split(",");
      if (!days.every((day) => WEEKDAY_CODES.has(day))) return undefined;
      rule.weekdays = days;
    } else if (rule.freq === "MONTHLY") {
      const match = /^(-?\d)([A-Z]{2})$/.exec(byDay);
      if (!match || !WEEKDAY_CODES.has(match[2])) return undefined;
      const position = Number(match[1]);
      if (position === 0 || position < -1 || position > 4) return undefined;
      rule.ordinal = { position, weekday: match[2] };
    } else {
      return undefined;
    }
  }

  const byMonthDay = parts.get("BYMONTHDAY");
  if (byMonthDay) {
    if (rule.freq !== "MONTHLY" || rule.ordinal) return undefined;
    const day = Number(byMonthDay);
    if (!Number.isInteger(day) || (day !== -1 && (day < 1 || day > 31))) return undefined;
    rule.monthDay = day;
  }

  return rule;
}

/** Days since 1970-01-01 for a `YYYY-MM-DD` date — a plain counter, free of any time zone. */
function dayNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** Monday-based week counter: two dates share a value exactly when they share a WKST=MO week. */
function weekNumber(date: string): number {
  // 1970-01-01 was a Thursday, so shifting by three puts every Monday on a multiple of seven.
  return Math.floor((dayNumber(date) + 3) / 7);
}

function monthIndex(date: string): number {
  const [year, month] = date.split("-").map(Number);
  return year * 12 + (month - 1);
}

/** Whether a rule anchored on `start` produces an occurrence on `date`. */
export function occursOn(rule: Rule, start: string, date: string): boolean {
  const order = compareDates(date, start);
  if (order < 0) return false;
  // RFC 5545 §3.8.5.3: DTSTART is always the first instance. The parser refuses rules that
  // disagree with it, so this is also what the rule itself says.
  if (order === 0) return true;

  switch (rule.freq) {
    case "DAILY":
      return (dayNumber(date) - dayNumber(start)) % rule.interval === 0;
    case "WEEKLY": {
      const days = rule.weekdays ?? [weekdayOf(start)];
      if (!days.includes(weekdayOf(date))) return false;
      return (weekNumber(date) - weekNumber(start)) % rule.interval === 0;
    }
    case "MONTHLY": {
      if ((monthIndex(date) - monthIndex(start)) % rule.interval !== 0) return false;
      const day = dayOfMonth(date);
      const [year, month] = date.split("-").map(Number);
      const last = daysInMonth(year, month);
      if (rule.ordinal) {
        if (weekdayOf(date) !== rule.ordinal.weekday) return false;
        return rule.ordinal.position === -1 ? day + 7 > last : Math.ceil(day / 7) === rule.ordinal.position;
      }
      if (rule.monthDay !== undefined) return rule.monthDay === -1 ? day === last : day === rule.monthDay;
      // No modifier: the start date's day of the month. A month without that day — the 31st in
      // April — is skipped, not moved, per RFC 5545.
      return day === dayOfMonth(start);
    }
    case "YEARLY": {
      const [startYear, startMonth, startDay] = start.split("-").map(Number);
      const [year, month, day] = date.split("-").map(Number);
      if ((year - startYear) % rule.interval !== 0) return false;
      // 29 February recurs only in leap years, for the same reason.
      return month === startMonth && day === startDay;
    }
  }
}

/**
 * Every day in `[from, to]` (inclusive) on which a task starting on `start` occurs.
 *
 * Without a rule, or with one this module does not read, the answer is the start date alone —
 * if it is in range. `limit` bounds a pathological range — a daily rule over a ten-year
 * look-back is 3,660 — never a month grid or an agenda.
 */
export function occurrencesBetween(start: string, rrule: string | undefined, from: string, to: string, limit = 5000): string[] {
  if (!isValidDate(start) || !isValidDate(from) || !isValidDate(to) || compareDates(from, to) > 0) return [];
  const rule = rrule ? readRule(rrule) : undefined;
  if (!rule) return compareDates(start, from) >= 0 && compareDates(start, to) <= 0 ? [start] : [];

  const found: string[] = [];
  let day = compareDates(start, from) > 0 ? start : from;
  while (compareDates(day, to) <= 0 && found.length < limit) {
    if (occursOn(rule, start, day)) found.push(day);
    day = addDays(day, 1);
  }
  return found;
}
