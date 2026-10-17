/**
 * The release notes shown once after an update.
 *
 * Short on purpose: the highlights a user would otherwise never discover, in their own words,
 * with the full changelog one click away. A test pins the newest entry to the manifest version,
 * so a release cannot ship announcing the previous one.
 */

export interface ReleaseHighlight {
  title: string;
  body: string;
}

export interface ReleaseNotes {
  version: string;
  /** False for a patch release whose notes are not worth interrupting anyone for. */
  showOnUpdate?: boolean;
  highlights: ReleaseHighlight[];
}

export const CHANGELOG_URL = "https://github.com/israerusan/obsidian-task-calendar-bridge/blob/main/CHANGELOG.md";

/** Newest first. */
export const RELEASE_NOTES: ReleaseNotes[] = [
  {
    version: "1.3.0",
    highlights: [
      {
        title: "Your calendar, inside the vault",
        body: "A new calendar view shows exactly what your calendar file holds: a month grid, an agenda you can click through to the task, and whether the file on disk is up to date. Open it from the ribbon or the command “Open task calendar”.",
      },
      {
        title: "Repeats drawn where they land",
        body: "Repeating tasks appear on every day they occur, the way your calendar app will show them.",
      },
      {
        title: "Ask any task how it exports",
        body: "Right-click a task line and choose “Explain calendar event” to see its date, time, repeat rule and identity, or exactly why it is not in the calendar.",
      },
      {
        title: "Quicker everyday actions",
        body: "Click the status bar for export, report and copy-path actions, and right-click any note in the file list to export just that note.",
      },
    ],
  },
];

/**
 * `a < b` for dotted versions, numerically: `1.10.0` is newer than `1.9.0`.
 * Anything unreadable compares as equal, so a malformed stored version never triggers a modal.
 */
export function isNewerVersion(candidate: string, than: string): boolean {
  const a = candidate.split(".").map(Number);
  const b = than.split(".").map(Number);
  if (a.some((n) => !Number.isFinite(n)) || b.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** `1.3.0`, `1.10.2` — the only shape this plugin's versions take. */
export function isReleaseVersion(value: string): boolean {
  return /^\d+(?:\.\d+)*$/.test(value);
}

/** Notes for every release newer than `seen` and no newer than `current`, newest first. */
export function notesSince(seen: string, current: string): ReleaseNotes[] {
  return RELEASE_NOTES.filter((notes) => isNewerVersion(notes.version, seen) && !isNewerVersion(notes.version, current));
}
