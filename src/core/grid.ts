import { addDays, daysInMonth, weekdayOf } from "./dates";

/**
 * The month grid the calendar view draws, as data.
 *
 * Kept out of the view so the arithmetic that is easy to get subtly wrong — which day a week
 * starts on, the ISO week number of a week straddling New Year, a February that fits in exactly
 * four rows — is reachable by a test rather than only by eye.
 */

export interface GridDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** False for the leading and trailing days borrowed from the neighbouring months. */
  inMonth: boolean;
  isToday: boolean;
  /** 0 = Sunday … 6 = Saturday, matching `Date#getDay`. */
  weekday: number;
}

export interface GridWeek {
  /** ISO 8601 week number of the week's Thursday-anchored year. */
  isoWeek: number;
  days: GridDay[];
}

const CODE_TO_INDEX = new Map<string, number>([
  ["SU", 0], ["MO", 1], ["TU", 2], ["WE", 3], ["TH", 4], ["FR", 5], ["SA", 6],
]);

export function weekdayIndex(date: string): number {
  return CODE_TO_INDEX.get(weekdayOf(date)) ?? 0;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function monthKey(year: number, month: number): string {
  return `${year}-${pad2(month)}`;
}

/** `{2026, 10}` plus `delta` months, carrying the year. `month` is 1-based. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 };
}

/**
 * ISO 8601 week number: weeks start on Monday, and week 1 is the one holding the year's first
 * Thursday. So 2027-01-01, a Friday, is in week 53 of 2026.
 */
export function isoWeekNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1, day));
  const dayIndex = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayIndex + 3); // the Thursday of this week
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayIndex = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayIndex + 3);
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

/**
 * Whole weeks covering the month, starting on `weekStartsOn` (0 = Sunday, 1 = Monday).
 *
 * Only as many rows as the month needs — four, five, or six — rather than a fixed six, so the
 * view does not spend a row of a narrow sidebar on a week that belongs to next month.
 */
export function monthGrid(year: number, month: number, weekStartsOn: number, today: string): GridWeek[] {
  const first = `${year}-${pad2(month)}-01`;
  const last = `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`;
  const lead = (weekdayIndex(first) - weekStartsOn + 7) % 7;

  const weeks: GridWeek[] = [];
  let cursor = addDays(first, -lead);
  while (cursor <= last) {
    const days: GridDay[] = [];
    for (let i = 0; i < 7; i++) {
      days.push({
        date: cursor,
        inMonth: cursor.startsWith(`${year}-${pad2(month)}-`),
        isToday: cursor === today,
        weekday: weekdayIndex(cursor),
      });
      cursor = addDays(cursor, 1);
    }
    // The ISO week is a Monday-to-Sunday idea, so it is read from the row's Monday whichever
    // day the row starts on. A Sunday-first row's Monday is its second cell.
    const monday = days.find((day) => day.weekday === 1) ?? days[0];
    weeks.push({ isoWeek: isoWeekNumber(monday.date), days });
  }
  return weeks;
}
