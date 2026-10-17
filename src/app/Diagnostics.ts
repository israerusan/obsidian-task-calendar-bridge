import type { TaskCalendarBridgeSettings } from "../settings/schema";

/**
 * A support snapshot a user can paste into a bug report.
 *
 * Most reports arrive as "my task isn't in the calendar" with nothing else, and the first reply
 * is always the same five questions: which version, free or Pro, which time mode, did the last
 * export fail, what did the report say. This answers them in one paste.
 *
 * It carries settings and counts only — never a task title, a tag, a note name, the vault's
 * name, the licence key, or the publish folder — so it is safe to post in a public issue.
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
    lines.push(`- Last export: ${last.scope}, ${last.at}${last.error ? `, FAILED: ${scrub(last.error)}` : ""}`);
    if (!last.error) {
      lines.push(`- Events: ${last.eventCount} of ${last.totalFound ?? last.eventCount} found; capped ${last.capped ?? 0}; duplicate ids ${last.duplicateIds?.length ?? 0}`);
      if (last.counts) lines.push(`- Skips: ${last.counts.lost} lost, ${last.counts.warnings} warnings, ${last.counts.excluded} excluded`);
      const reasons = new Map<string, number>();
      for (const item of last.skipped ?? []) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
      if (reasons.size > 0) {
        lines.push(`- Skip reasons (sampled): ${[...reasons].map(([reason, count]) => `${reason} ×${count}`).join(", ")}`);
      }
      if (last.publishError) lines.push(`- Publish error: ${scrub(last.publishError)}`);
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
 * Error messages name paths. A vault-relative path is fine to share; an absolute one carries the
 * user's account name and folder layout, so it is cut down to its last segment.
 */
export function scrub(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'`]*\\([^\\\s"'`]+)/g, "…\\$1")
    // No lookbehind: it is a syntax error on the older iOS WebKit some Obsidian installs run on,
    // and a syntax error there takes the whole plugin down at load.
    .replace(/(^|[\s"'`(])\/(?:[^/\s"'`]+\/)+([^/\s"'`]+)/g, "$1…/$2");
}
