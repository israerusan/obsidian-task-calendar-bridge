import {
  compareTasks,
  countSkips,
  generateIcsCalendar,
  icsSignature,
  isSameFile,
  sampleSkips,
  selectUpcoming,
  validateOutputPath,
  type CalendarTask,
  type DuplicateIdentity,
  type ExportReport,
  type SkippedTask,
  type TimeMode,
} from "../core";
import type { LastExport } from "../settings/schema";
import type { Entitlements } from "./Entitlements";

/**
 * The export, as a pure function.
 *
 * Everything from "which tasks survived the filter" to "what the notice should say" is decided
 * here, from values passed in. Three things used to break that: `vault.getName()` was read in
 * the middle of building the ICS options, `new Date()` was called inline while recording the
 * result, and `summarise()` — a string formatter — mutated the flag that suppresses the repeat
 * upsell. All three are now inputs and outputs, which is the whole reason this file can be
 * tested at all: it imports nothing from `obsidian`.
 */

export interface PrecheckInput {
  /** True when data.json exists but could not be read. */
  settingsUnreadable: boolean;
  dataPath: string;
  rawPath: string;
  vaultOutputPath: string;
  currentNoteOutputPath: string;
}

export type Precheck = { ok: true; path: string } | { ok: false; message: string };

/**
 * The refusals that must happen before a single note is read, in this order.
 *
 * Order is behaviour, not style: the settings check comes first because with settings we could
 * not read, every value below it is an invented default — including the output path, which
 * `assertSafeTarget` would then happily overwrite because the file it is about to destroy is
 * one of ours.
 */
export function precheckExport(input: PrecheckInput): Precheck {
  if (input.settingsUnreadable) {
    return {
      ok: false,
      message:
        `Task Calendar Bridge will not export while it cannot read its settings: it would write over your calendar using default settings. ` +
        `Restore or fix ${input.dataPath} and restart Obsidian.`,
    };
  }

  const check = validateOutputPath(input.rawPath);
  if (!check.ok) return { ok: false, message: check.error ?? "Invalid output path." };

  // Compared case-insensitively: on Windows and macOS `Calendar/Tasks.ics` and
  // `calendar/tasks.ics` are one file, and each scope would overwrite the other.
  if (isSameFile(input.vaultOutputPath, input.currentNoteOutputPath)) {
    return { ok: false, message: "The vault and current-note output paths are the same file. Give them different paths." };
  }

  return { ok: true, path: check.path };
}

/** The free tier exports the next N upcoming tasks; Pro exports everything. */
export function selectForExport(
  all: CalendarTask[],
  rights: Entitlements,
  today: string
): { tasks: CalendarTask[]; totalFound: number; capped: number } {
  if (rights.taskLimit === null) return { tasks: [...all].sort(compareTasks), totalFound: all.length, capped: 0 };
  const tasks = selectUpcoming(all, rights.taskLimit, today);
  return { tasks, totalFound: all.length, capped: Math.max(0, all.length - tasks.length) };
}

export interface CalendarOptions {
  calendarName: string;
  defaultDurationMinutes: number;
  timeMode: TimeMode;
  timeZone: string;
  allDayReminderTime: string;
  exportTags: boolean;
  linkToSource: boolean;
}

export interface BuildCalendarInput {
  tasks: CalendarTask[];
  skipped: SkippedTask[];
  options: CalendarOptions;
  /** Read once by the caller, not reached for mid-computation. */
  vaultName: string;
  /** Injected, so the same inputs always produce the same calendar. */
  now: Date;
}

export interface BuiltCalendar {
  ics: string;
  /** The content minus DTSTAMP — what the writer compares to decide whether to write. */
  signature: string;
  eventCount: number;
  duplicates: DuplicateIdentity[];
  counts: ReturnType<typeof countSkips>;
  /** A bounded sample with rows for every reason present. */
  sample: SkippedTask[];
}

const PRODUCT_ID = "-//Task Calendar Bridge//EN";
/** Duplicate-id records kept in the persisted copy. */
const PERSISTED_DUPLICATE_LIMIT = 50;

/**
 * Step one: the calendar itself.
 *
 * Separate from the report because the write and the publish happen *between* them — the report
 * has to say where the file was published to, and that is not known until it has been. Splitting
 * here keeps both halves pure rather than pretending the sequence is something it is not.
 */
export function buildCalendar(input: BuildCalendarInput): BuiltCalendar {
  const { ics, eventCount, duplicateIds } = generateIcsCalendar(
    input.tasks,
    {
      calendarName: input.options.calendarName,
      productId: PRODUCT_ID,
      defaultDurationMinutes: input.options.defaultDurationMinutes,
      timeMode: input.options.timeMode,
      timeZone: input.options.timeZone,
      allDayReminderTime: input.options.allDayReminderTime,
      vaultName: input.vaultName,
      exportTags: input.options.exportTags,
      linkToSource: input.options.linkToSource,
    },
    input.now
  );

  return {
    ics,
    signature: icsSignature(ics),
    eventCount,
    duplicates: duplicateIds.map((task) => ({ sourcePath: task.sourcePath, line: task.line, title: task.title })),
    counts: countSkips(input.skipped),
    sample: sampleSkips(input.skipped),
  };
}

export interface ReportInput {
  scope: string;
  path: string;
  totalFound: number;
  capped: number;
  freeLimit: number;
  now: Date;
  publishedTo?: string;
  publishError?: string;
}

/** Step two: what the user is shown, and what is persisted so it survives a restart. */
export function planReport(built: BuiltCalendar, input: ReportInput): { report: ExportReport; lastExport: LastExport } {
  const report: ExportReport = {
    scope: input.scope,
    path: input.path,
    eventCount: built.eventCount,
    totalFound: input.totalFound,
    capped: input.capped,
    duplicateIds: built.duplicates,
    counts: built.counts,
    skipped: built.sample,
    publishedTo: input.publishedTo,
    publishError: input.publishError,
    freeLimit: input.freeLimit,
  };

  return {
    report,
    lastExport: {
      at: input.now.toISOString(),
      scope: input.scope,
      path: input.path,
      eventCount: built.eventCount,
      skippedCount: built.counts.lost,
      counts: built.counts,
      duplicateIds: built.duplicates.slice(0, PERSISTED_DUPLICATE_LIMIT),
      publishError: input.publishError,
      // Persisted so "Show last export report" still works after a restart — which is exactly
      // when a user notices tasks missing from their calendar.
      skipped: built.sample,
      totalFound: input.totalFound,
      capped: input.capped,
    },
  };
}

/**
 * Two sentences: what happened, and the single most important thing to know about it.
 *
 * Returns whether the free-tier upsell was used rather than setting a flag on the plugin, which
 * is what made this formatter impure. The caller owns the flag; it is session-scoped on purpose,
 * so the nudge appears once per session and not once per install.
 */
export function summariseExport(report: ExportReport, capNoticeAlreadyShown: boolean): { message: string; capNoticeShown: boolean } {
  const headline = `Exported ${report.eventCount} event${report.eventCount === 1 ? "" : "s"} to ${report.path}.`;
  const keep = (message: string): { message: string; capNoticeShown: boolean } => ({ message, capNoticeShown: capNoticeAlreadyShown });

  // A publish failure outranks everything: the calendar on disk is right, but the copy people
  // have subscribed to is not.
  if (report.publishError) return keep(`${headline} Publishing outside the vault failed: ${report.publishError}`);

  if (report.eventCount === 0) {
    return keep(`${headline} It has no events, and most calendar apps refuse to import an empty calendar — check “Show last export report”.`);
  }

  if (report.counts.lost > 0) {
    const lost = report.counts.lost;
    return keep(`${headline} ${lost} task${lost === 1 ? "" : "s"} could not be exported — run “Show last export report” for details.`);
  }

  if (report.capped > 0 && !capNoticeAlreadyShown) {
    return {
      message: `${headline} Your vault has ${report.totalFound} dated tasks; the free tier exports the next ${report.freeLimit}. See the export report to unlock the rest.`,
      capNoticeShown: true,
    };
  }

  if (report.counts.warnings > 0) {
    const warnings = report.counts.warnings;
    return keep(`${headline} ${warnings} task${warnings === 1 ? "" : "s"} exported with a field ignored — see the export report.`);
  }

  return keep(report.publishedTo ? `${headline} Also published to ${report.publishedTo}.` : headline);
}
