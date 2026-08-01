/**
 * Output-path safety.
 *
 * The 1.0.x settings tab accepted any string and the writer overwrote whatever
 * was there, so a typo like `Projects.md` destroyed that note. Every path the
 * user can type now goes through here first.
 */

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

/** Collapses separators and strips leading/trailing slashes; no I/O. */
export function normalizeVaultPath(input: string): string {
  return input
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * Folder matching on path boundaries: `Work` must not also select `Workshop`.
 */
export function isInFolder(path: string, folder: string): boolean {
  const normalized = normalizeVaultPath(folder);
  if (!normalized) return false;
  return path === normalized || path.startsWith(`${normalized}/`);
}

export function splitFolders(value: string): string[] {
  return value
    .split(",")
    .map((part) => normalizeVaultPath(part))
    .filter(Boolean);
}
