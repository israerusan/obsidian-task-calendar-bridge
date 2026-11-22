import { Platform } from "obsidian";

/**
 * Optional Pro capability: write a second copy of the calendar to a folder
 * outside the vault — typically one a cloud drive syncs — so a calendar app can
 * subscribe to a URL that keeps updating instead of the user re-importing a file
 * by hand. Isolated in this file because it is the only code that touches the
 * filesystem directly, and it is desktop-only by nature.
 */

interface NodeFs {
  promises: {
    mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
    writeFile(path: string, data: string, encoding: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    rm(path: string, options: { force: boolean }): Promise<void>;
    readFile(path: string, encoding: string): Promise<string>;
  };
}

function loadFs(): NodeFs | undefined {
  const req = (window as unknown as { require?: (module: string) => unknown }).require;
  if (typeof req !== "function") return undefined;
  try {
    return req("fs") as NodeFs;
  } catch {
    return undefined;
  }
}

export function isPublishSupported(): boolean {
  return Platform.isDesktopApp && loadFs() !== undefined;
}

/**
 * Returns the full path written, or undefined when `alive` went false part-way and the write was
 * abandoned. Throws with a message meant for a Notice.
 *
 * `alive` is re-checked between the filesystem steps: a plugin disabled while `mkdir` was pending
 * would otherwise go on to rename an older calendar over the one a freshly loaded instance had
 * just published to the same place.
 */
export async function publishCalendar(folder: string, fileName: string, contents: string, alive: () => boolean = () => true): Promise<string | undefined> {
  const target = folder.trim();
  if (!target) throw new Error("Set a publish folder first.");
  // A relative path would resolve against the process working directory, which
  // is wherever Obsidian happened to be launched from — never what a user means.
  if (!isAbsolutePath(target)) {
    throw new Error(`"${target}" is not an absolute folder path. Use the full path, for example /Users/you/Dropbox/calendar.`);
  }
  if (!Platform.isDesktopApp) throw new Error("Publishing outside the vault only works on desktop.");

  const fs = loadFs();
  if (!fs) throw new Error("This build of Obsidian cannot write outside the vault.");

  const separator = target.includes("\\") && !target.includes("/") ? "\\" : "/";
  const normalized = target.replace(/[\\/]+$/, "");
  const fullPath = `${normalized}${separator}${fileName}`;
  // Written beside the target so the rename stays on one filesystem, and named
  // so it is obvious what it is if a crash ever leaves one behind. Unique per
  // write: with one shared name, a disabled instance finishing late could
  // overwrite — or clean up — the temp file a freshly loaded instance was about
  // to rename into place, failing or corrupting the newer publish.
  const tempPath = `${fullPath}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tcb-tmp`;

  try {
    await fs.promises.mkdir(normalized, { recursive: true });
    if (!alive()) return undefined;
    // Write, then rename over the target. This is the file a calendar app polls
    // and a cloud client syncs, and both can read it at any instant: writing in
    // place truncates first, so either could pick up a calendar with no
    // END:VCALENDAR — and an interrupted write left the last good feed
    // destroyed rather than merely stale.
    await fs.promises.writeFile(tempPath, contents, "utf8");
    if (!alive()) {
      await removeQuietly(fs, tempPath);
      return undefined;
    }
    await fs.promises.rename(tempPath, fullPath);
  } catch (error) {
    // Best-effort: a leftover temp file next to the calendar is confusing, and
    // on Windows it also blocks the next rename.
    await removeQuietly(fs, tempPath);
    throw new Error(`Could not write to ${normalized}: ${describe(error)}`);
  }

  return fullPath;
}

/**
 * A previously published file's contents, or undefined when it is gone or cannot be read.
 * Read rather than merely stat'ed: something else may have rewritten it in place.
 */
export async function readPublishedFile(fullPath: string): Promise<string | undefined> {
  const fs = loadFs();
  if (!fs) return undefined;
  try {
    return await fs.promises.readFile(fullPath, "utf8");
  } catch {
    return undefined;
  }
}

/** Best-effort removal of a temp file; the caller has already decided what to report. */
async function removeQuietly(fs: NodeFs, path: string): Promise<void> {
  try {
    await fs.promises.rm(path, { force: true });
  } catch {
    // Nothing more to do.
  }
}

/** POSIX `/x`, Windows `C:\x` or `C:/x`, and UNC `\\server\share`. */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
