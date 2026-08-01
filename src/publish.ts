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
    stat(path: string): Promise<{ isDirectory(): boolean }>;
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

/** Returns the full path written. Throws with a message meant for a Notice. */
export async function publishCalendar(folder: string, fileName: string, contents: string): Promise<string> {
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

  try {
    await fs.promises.mkdir(normalized, { recursive: true });
    await fs.promises.writeFile(fullPath, contents, "utf8");
  } catch (error) {
    throw new Error(`Could not write to ${normalized}: ${describe(error)}`);
  }

  return fullPath;
}

/** POSIX `/x`, Windows `C:\x` or `C:/x`, and UNC `\\server\share`. */
function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
