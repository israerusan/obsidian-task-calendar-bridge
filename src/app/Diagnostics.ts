import type { TaskCalendarBridgeSettings } from "../settings/schema";

/**
 * A support snapshot a user can paste into a bug report.
 *
 * Most reports arrive as "my task isn't in the calendar" with nothing else, and the first reply
 * is always the same five questions: which version, free or Pro, which time mode, did the last
 * export fail, what did the report say. This answers them in one paste.
 *
 * It carries settings, counts and error *categories* only — never a task title, a tag, a note
 * name, a folder name, the vault's name, the licence key, or the publish folder — so it is safe
 * to post in a public issue. Error messages are not copied at all: they are written for the
 * person at the keyboard and name paths, so each one is reduced to a category from a fixed list.
 */

export interface DiagnosticsInput {
  pluginVersion: string;
  obsidianVersion: string;
  platform: string;
  settings: TaskCalendarBridgeSettings;
  publishSupported: boolean;
}

export function buildDiagnostics(input: DiagnosticsInput): string {
  const { settings: s } = input;
  const last = s.lastExport;
  const lines = [
    "Task Calendar Bridge diagnostics",
    `- Version: ${input.pluginVersion} (Obsidian ${input.obsidianVersion}, ${input.platform})`,
    `- Licence: ${s.isPro ? "Pro" : "free"}`,
    `- Time mode: ${s.timeMode === "zoned" ? `fixed time zone (${s.timeZone || "unset"})` : "local wall time"}`,
    `- Default duration: ${s.defaultDurationMinutes} min; all-day reminder time: ${s.allDayReminderTime}`,
    `- Options: tags as categories ${onOff(s.exportTags)}, links to source ${onOff(s.linkToSource)}`,
    `- Pro options: auto-export ${onOff(s.autoExport)}, repeats ${onOff(s.includeRecurrence)}, reminders ${onOff(s.includeReminders)}, completed ${onOff(s.includeCompleted)}`,
    `- Folder filters: include ${countFolders(s.includeFolders)}, exclude ${countFolders(s.excludeFolders)}`,
    `- Publishing: ${s.publishEnabled ? (s.publishPath.trim() ? "on, folder set" : "on, NO folder set") : "off"}${input.publishSupported ? "" : " (not available on this device)"}`,
  ];

  if (!last) {
    lines.push("- Last export: none recorded");
  } else {
    lines.push(`- Last export: ${last.scope}, ${last.at}${last.error ? `, FAILED (${classifyError(last.error)})` : ""}`);
    if (!last.error) {
      lines.push(`- Events: ${last.eventCount} of ${last.totalFound ?? last.eventCount} found; capped ${last.capped ?? 0}; duplicate ids ${last.duplicateIds?.length ?? 0}`);
      if (last.counts) lines.push(`- Skips: ${last.counts.lost} lost, ${last.counts.warnings} warnings, ${last.counts.excluded} excluded`);
      const reasons = new Map<string, number>();
      for (const item of last.skipped ?? []) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
      if (reasons.size > 0) {
        lines.push(`- Skip reasons (sampled): ${[...reasons].map(([reason, count]) => `${reason} ×${count}`).join(", ")}`);
      }
      if (last.publishError) lines.push(`- Publish error: ${classifyError(last.publishError)}`);
    }
  }
  return lines.join("\n");
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function countFolders(value: string): string {
  const count = value.split(",").filter((part) => part.trim()).length;
  return count === 0 ? "none" : `${count} folder${count === 1 ? "" : "s"}`;
}

/**
 * Every failure this plugin can record, as a category with no user data in it.
 *
 * Redacting paths out of a free-text message was tried first and cannot be made safe: a note
 * name with spaces in it is indistinguishable from the prose around it. A fixed list can be.
 * The order matters only where two patterns could both match; the more specific comes first.
 */
const ERROR_CATEGORIES: Array<[RegExp, string]> = [
  [/could not read its settings/i, "settings file unreadable"],
  [/not created by this plugin/i, "output path belongs to another file"],
  [/same file|must be different files/i, "output paths are the same file"],
  [/enter a path for the calendar|must end in \.ics|must stay inside the vault|path cannot contain|cannot start or end with a space/i, "invalid output path"],
  [/no longer a file in this vault/i, "a note vanished during export"],
  [/no publish folder|set a publish folder/i, "publish folder not set"],
  [/not an absolute folder path/i, "publish folder not absolute"],
  [/only works on desktop|cannot write outside the vault/i, "publishing unavailable on this device"],
  [/is a pro feature and is no longer running/i, "publishing stopped: licence inactive"],
  [/could not write to/i, "publish write failed"],
];

/** A category for an error message, plus its errno code when it carries one (EACCES, EBUSY…). */
export function classifyError(message: string): string {
  const errno = /\b(E[A-Z]{2,12})\b/.exec(message)?.[1];
  const found = ERROR_CATEGORIES.find(([pattern]) => pattern.test(message));
  const category = found ? found[1] : "other error";
  return errno ? `${category}, ${errno}` : category;
}
