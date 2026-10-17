import { addDays, compareDates, createUid, icsSignature, occurrencesBetween, type CalendarTask, type DuplicateIdentity, type SkipCounts, type SkippedTask } from "../core";
import { buildCalendar, selectForExport, type CalendarOptions } from "./ExportPlan";
import type { Entitlements } from "./Entitlements";

/**
 * What the next whole-vault export would contain, for the calendar view.
 *
 * Built from exactly the pieces the export itself uses — `selectForExport` for the free cap,
 * `buildCalendar` for the identity rules — so the view cannot drift from the file. A preview
 * that showed a task the export then dropped, or hid one the export kept, would be worse than
 * no preview: it is the one place a user checks before trusting the calendar.
 */

export type PreviewState =
  /** In the calendar file. */
  | "exported"
  /** Dated and valid, but past the free tier's cap. */
  | "capped"
  /** Shares an identity with an earlier task, so the export drops it. */
  | "duplicate";

export interface PreviewItem {
  task: CalendarTask;
  uid: string;
  state: PreviewState;
}

export interface CalendarPreview {
  items: PreviewItem[];
  /** Events the file would hold. */
  eventCount: number;
  capped: number;
  duplicates: number;
  /** Genuine losses, warnings, and exclusions, counted the way the report counts them. */
  counts: SkipCounts;
  /** The report's sample of skips and the duplicate list, for "see why" without exporting. */
  sample: SkippedTask[];
  duplicateIds: DuplicateIdentity[];
  /** Dated tasks found, before the free cap. */
  totalFound: number;
  /** The calendar the export would write, minus DTSTAMP — comparable with the file on disk. */
  signature: string;
}

export interface PreviewInput {
  tasks: CalendarTask[];
  skipped: SkippedTask[];
  rights: Entitlements;
  today: string;
  options: CalendarOptions;
  vaultName: string;
  now: Date;
}

export function buildPreview(input: PreviewInput): CalendarPreview {
  const selected = selectForExport(input.tasks, input.rights, input.today);
  const built = buildCalendar({ tasks: selected.tasks, skipped: input.skipped, options: input.options, vaultName: input.vaultName, now: input.now });

  const inFile = new Set(selected.tasks);
  // The generator keeps the FIRST task with a given identity, in export order; mirror that
  // rather than trusting the duplicate list to identify objects.
  const claimed = new Set<string>();
  const items: PreviewItem[] = [];
  let duplicates = 0;
  for (const task of selected.tasks) {
    const uid = createUid(task);
    if (claimed.has(uid)) {
      duplicates++;
      items.push({ task, uid, state: "duplicate" });
      continue;
    }
    claimed.add(uid);
    items.push({ task, uid, state: "exported" });
  }
  for (const task of input.tasks) {
    if (!inFile.has(task)) items.push({ task, uid: createUid(task), state: "capped" });
  }

  return {
    items,
    eventCount: built.eventCount,
    capped: selected.capped,
    duplicates,
    counts: built.counts,
    sample: built.sample,
    duplicateIds: built.duplicates,
    totalFound: input.tasks.length,
    signature: built.signature,
  };
}

/** Whether the file on disk already holds what the next export would write. */
export function isCalendarCurrent(preview: CalendarPreview, fileContents: string | null): boolean {
  if (fileContents === null) return false;
  return icsSignature(fileContents) === preview.signature;
}

export type EntryKind =
  /** The event's own date. */
  | "start"
  /** A later instance of a repeating event. */
  | "repeat"
  /** A day inside a multi-day event, after the first. */
  | "continues";

export interface DayEntry {
  item: PreviewItem;
  date: string;
  kind: EntryKind;
}

/**
 * How far back to look for an instance of a REPEATING multi-day event that started before the
 * window and is still running in it. A one-off event needs no look-back at all — its span is
 * intersected with the window directly — so this bounds only the pathological case of a rule
 * whose every instance lasts longer than ten years.
 */
const MAX_REPEAT_LOOKBACK_DAYS = 3660;

/**
 * Every visible day an item touches, between `from` and `to` inclusive, grouped by day and
 * sorted the way the export sorts — all-day first, then by start time.
 *
 * Repeats are expanded only where the export would have written a rule: on the free tier a
 * repeat rule is dropped, so the preview shows a single event, just as the calendar app will.
 */
export function entriesByDay(items: PreviewItem[], from: string, to: string): Map<string, DayEntry[]> {
  const days = new Map<string, DayEntry[]>();
  const add = (entry: DayEntry): void => {
    const list = days.get(entry.date) ?? [];
    list.push(entry);
    days.set(entry.date, list);
  };

  for (const item of items) {
    const { task } = item;
    const spanDays = task.endDate ? Math.max(0, daysBetween(task.date, task.endDate)) : 0;
    // A one-off event starts once; a repeating one on every occurrence, so look back far enough
    // to catch an instance that began before the window and is still running inside it.
    const starts = task.recurrence
      ? occurrencesBetween(task.date, task.recurrence.rrule, addDays(from, -Math.min(spanDays, MAX_REPEAT_LOOKBACK_DAYS)), to)
      : compareDates(task.date, to) <= 0
        ? [task.date]
        : [];
    for (const start of starts) {
      const kind: EntryKind = start === task.date ? "start" : "repeat";
      if (compareDates(start, from) >= 0) add({ item, date: start, kind });
      // Only the part of the span inside the window is walked, however long the event: a task
      // running January to June still has its June days, and costs the same as a short one.
      const last = addDays(start, spanDays);
      let day = compareDates(addDays(start, 1), from) >= 0 ? addDays(start, 1) : from;
      while (compareDates(day, last) <= 0 && compareDates(day, to) <= 0) {
        add({ item, date: day, kind: "continues" });
        day = addDays(day, 1);
      }
    }
  }

  for (const list of days.values()) list.sort(compareEntries);
  return days;
}

function compareEntries(a: DayEntry, b: DayEntry): number {
  const aTime = a.kind === "continues" ? "" : a.item.task.startTime ?? "";
  const bTime = b.kind === "continues" ? "" : b.item.task.startTime ?? "";
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  return a.item.uid < b.item.uid ? -1 : a.item.uid > b.item.uid ? 1 : 0;
}

function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}
