import type { SkippedTask } from "./types";

/**
 * The shape of an export's result, and the rules for summarising it.
 *
 * Lives in core rather than beside the modal that renders it: the plugin builds these, the
 * settings tab persists them, and the modal displays them, so putting the definitions in the
 * UI file forced two modules to import a third one for its types and created an import cycle
 * that only survived because every edge happened to be type-only.
 */

/** A task dropped because another task already claimed the same identity. */
export interface DuplicateIdentity {
  sourcePath: string;
  line: number;
  title: string;
}

/**
 * How many tasks fell into each bucket across the WHOLE export.
 *
 * Counted separately from the sample rows, which are capped: the headings have to state the
 * real totals even when the list shows only the first few of each kind.
 */
export interface SkipCounts {
  /** Did not reach the calendar, and the user did not ask for that. */
  lost: number;
  /** Exported, but one field of it could not be read. */
  warnings: number;
  /** Left out on purpose by a setting. Working as configured. */
  excluded: number;
}

export interface ExportReport {
  scope: string;
  path: string;
  eventCount: number;
  totalFound: number;
  capped: number;
  duplicateIds: DuplicateIdentity[];
  /** A sample, capped per reason. `counts` holds the real totals. */
  skipped: SkippedTask[];
  counts: SkipCounts;
  publishedTo?: string;
  publishError?: string;
  freeLimit: number;
}

/** Excluded on purpose by a setting, rather than lost. */
const BY_SETTING = new Set(["completed", "cancelled", "repeat-not-enabled", "reminder-not-enabled"]);

/** One pass, three buckets — the classification every surface has to agree on. */
export function countSkips(skipped: SkippedTask[]): SkipCounts {
  const counts: SkipCounts = { lost: 0, warnings: 0, excluded: 0 };
  for (const item of skipped) {
    if (!item.fatal) BY_SETTING.has(item.reason) ? counts.excluded++ : counts.warnings++;
    else if (BY_SETTING.has(item.reason)) counts.excluded++;
    else counts.lost++;
  }
  return counts;
}

/** Whether a skip reason means "left out on purpose", for grouping in the report. */
export function isExcludedBySetting(reason: string): boolean {
  return BY_SETTING.has(reason);
}

/** How many skip records per reason are kept for display; `counts` carries the real totals. */
export const REPORT_LIMIT_PER_REASON = 25;

/**
 * A bounded sample that still has rows for every reason present.
 *
 * The report groups skips by reason and shows a handful of each, so the sample has to be taken
 * per reason: a flat slice of the first N was all "completed" in any real vault, leaving the
 * "Not exported" heading — the entire point of the report — with a count and nothing under it.
 */
export function sampleSkips(skipped: SkippedTask[]): SkippedTask[] {
  const perReason = new Map<string, SkippedTask[]>();
  for (const item of skipped) {
    const bucket = perReason.get(item.reason) ?? [];
    if (bucket.length < REPORT_LIMIT_PER_REASON) bucket.push(item);
    perReason.set(item.reason, bucket);
  }
  return [...perReason.values()].flat();
}

/**
 * The calendar's content, minus the one property that changes on every run.
 *
 * Two exports of unchanged tasks differ only in DTSTAMP, so comparing signatures is how the
 * writer knows not to rewrite a file — which would otherwise churn every sync client and make
 * everyone subscribed to the feed re-download an identical calendar.
 */
export function icsSignature(ics: string): string {
  return ics.replace(/DTSTAMP:[^\r\n]*/g, "");
}

/**
 * Whether a file's contents are the calendar a signature describes.
 *
 * Tolerant of exactly the two things a sync client or git does to a text file without changing
 * what it means: a byte-order mark, and CRLF turned into LF. Without that tolerance the calendar
 * view called such a file "out of date" forever, and exporting could not fix it.
 */
export function matchesSignature(fileContents: string, signature: string): boolean {
  const normalise = (value: string): string => value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return normalise(icsSignature(fileContents)) === normalise(signature);
}
