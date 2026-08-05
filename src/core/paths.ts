/**
 * Output-path safety.
 *
 * The 1.0.x settings tab accepted any string and the writer overwrote whatever
 * was there, so a typo like `Projects.md` destroyed that note. Every path the
 * user can type now goes through here first.
 */

/**
 * The default output paths.
 *
 * They live here rather than only in DEFAULT_SETTINGS because the setup guide
 * documents them and the guide's test has to check the real values: asserting
 * against a copied literal let a changed default leave the guide telling users
 * to look for a file that is no longer written there.
 */
export const DEFAULT_VAULT_OUTPUT_PATH = "Calendar/tasks.ics";
export const DEFAULT_CURRENT_NOTE_OUTPUT_PATH = "Calendar/current-note.ics";

export interface PathCheck {
  ok: boolean;
  path: string;
  error?: string;
}

const ILLEGAL = /[\\:*?"<>|]/;

export function validateOutputPath(input: string): PathCheck {
  const path = normalizeVaultPath(input);

  if (!path) return { ok: false, path, error: "Enter a path for the calendar file." };
  if (!/\.ics$/i.test(path)) {
    return { ok: false, path, error: "The path must end in .ics so the plugin can never overwrite a note." };
  }
  if (path.split("/").some((part) => part === "..")) {
    return { ok: false, path, error: "The path must stay inside the vault." };
  }
  if (ILLEGAL.test(path)) {
    return { ok: false, path, error: 'The path cannot contain \\ : * ? " < > or |.' };
  }
  if (path.split("/").some((part) => part.trim() !== part)) {
    return { ok: false, path, error: "Folder and file names cannot start or end with a space." };
  }

  return { ok: true, path };
}

/**
 * Collapses separators and strips leading/trailing slashes; no I/O.
 *
 * Also folds the two invisible spaces and applies NFC, matching what Obsidian's
 * own `normalizePath` does to the path just before the write. When the two
 * disagreed, the string stored in settings was not the string on disk, and every
 * comparison against it — "is this my own output file?" — quietly answered no.
 */
export function normalizeVaultPath(input: string): string {
  return input
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    // The two invisible spaces a paste can carry in: NBSP and narrow NBSP.
    .replace(/[\u00A0\u202F]/g, " ")
    .normalize("NFC");
}

/**
 * Whether two vault paths name the same file.
 *
 * Case-insensitive, because that is how Windows and macOS behave. One shared
 * definition on purpose: the settings tab used to compare case-sensitively and
 * accept a pair the exporter then rejected, so the user saved a setting that
 * silently broke every future export.
 */
export function isSameFile(a: string, b: string): boolean {
  return normalizeVaultPath(a).toLowerCase() === normalizeVaultPath(b).toLowerCase();
}

/**
 * Folder matching on path boundaries: `Work` must not also select `Workshop`.
 */
export function isInFolder(path: string, folder: string): boolean {
  const normalized = normalizeVaultPath(folder);
  if (!normalized) return false;
  return path === normalized || path.startsWith(`${normalized}/`);
}

/** Which notes an export covers. Both lists are comma-separated folder names. */
export interface FolderFilter {
  includeFolders: string;
  excludeFolders: string;
  /** Include lists are a Pro capability; exclusions are not. See below. */
  useIncludeFolders: boolean;
  /** The plugin's own output files, which are never inputs. */
  outputPaths: string[];
}

/**
 * Whether a note's tasks belong in the export.
 *
 * Used for two different questions that must answer identically: which files the vault walk
 * reads, and whether a change to a file is worth re-exporting for. When they disagreed, an edit
 * inside an excluded folder triggered a full re-export that could not change a single byte.
 */
export function shouldIncludeNote(path: string, filter: FolderFilter): boolean {
  if (filter.outputPaths.some((output) => isSameFile(path, output))) return false;

  // Exclusions apply whether or not Pro is active. Gating them on the licence made losing one
  // *add* content: a user who had excluded Archive and Templates suddenly found hundreds of old
  // tasks and template placeholders in their calendar. Turning a paid feature off must never
  // widen the output.
  const excludes = splitFolders(filter.excludeFolders);
  if (excludes.some((folder) => isInFolder(path, folder))) return false;

  // An include list is a genuine Pro capability, so it lapses with the licence.
  if (!filter.useIncludeFolders) return true;
  const includes = splitFolders(filter.includeFolders);
  // Boundary matching: "Work" must not also select "Workshop/notes.md".
  if (includes.length > 0 && !includes.some((folder) => isInFolder(path, folder))) return false;
  return true;
}

export function splitFolders(value: string): string[] {
  return value
    .split(",")
    .map((part) => normalizeVaultPath(part))
    .filter(Boolean);
}
