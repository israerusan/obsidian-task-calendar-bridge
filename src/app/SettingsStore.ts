import { normalizeVaultPath, validateOutputPath } from "../core";
import { DEFAULT_SETTINGS, type TaskCalendarBridgeSettings } from "../settings/schema";
import type { TaskLane } from "./TaskLane";

/**
 * Loading and saving data.json, and refusing to do either when that would lose something.
 *
 * The dangerous case is narrow and was invisible: `loadData()` returns null both for "there is
 * no data.json yet" and for "data.json is there but could not be read or parsed" — a force-quit
 * mid-write, a cloud-sync conflict, a file the OS still has open. Treating the second as a first
 * run made the plugin write its defaults straight over the top, taking with it the only copy of
 * the Pro key the user paid for.
 *
 * So when the file exists and could not be read, this store refuses to write anything at all,
 * for the rest of the session.
 */

export interface DataStore {
  /** Null for both "missing" and "unreadable" — which is the whole problem. */
  load(): Promise<unknown>;
  save(settings: TaskCalendarBridgeSettings): Promise<void>;
  /** Where data.json lives. Built from the vault's config dir, which users can rename. */
  path(): string;
  exists(path: string): Promise<boolean>;
}

export interface LoadOutcome {
  /** True when data.json exists but could not be read. Nothing may be saved. */
  unreadable: boolean;
  /** A message to show the user, if there is something they need to do. */
  notice?: string;
}

export class SettingsStore {
  settings: TaskCalendarBridgeSettings = { ...DEFAULT_SETTINGS };
  unreadable = false;

  constructor(
    private readonly data: DataStore,
    private readonly lane: TaskLane,
    private readonly alive: () => boolean
  ) {}

  async load(): Promise<LoadOutcome> {
    const loaded = await this.data.load();

    if (loaded === null && (await this.dataFileExists())) {
      this.unreadable = true;
      this.settings = { ...DEFAULT_SETTINGS };
      return {
        unreadable: true,
        notice:
          `Task Calendar Bridge could not read its settings file, so it has not changed anything. ` +
          `Your license key and settings are still in ${this.data.path()} — restore or fix that file and restart Obsidian. ` +
          `Nothing will be saved until then.`,
      };
    }

    const record = loaded !== null && typeof loaded === "object" ? (loaded as Record<string, unknown>) : {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, record);
    if (!Array.isArray(this.settings.ownedPaths)) this.settings.ownedPaths = [];
    // The checkout link is a constant now; a persisted copy would outrank it forever and freeze
    // every install on the URL it first shipped with.
    delete (this.settings as unknown as Record<string, unknown>).purchaseUrl;

    return { unreadable: false, notice: this.migrateFrom104(record) };
  }

  private async dataFileExists(): Promise<boolean> {
    try {
      return await this.data.exists(this.data.path());
    } catch {
      // Cannot tell. Assume it is there: refusing to save is recoverable, and overwriting a
      // license key is not.
      return true;
    }
  }

  /**
   * 1.0.x kept a single `outputPath` that both export scopes wrote to.
   *
   * Runs exactly once: the legacy keys are consumed and deleted. Leaving them in data.json
   * re-applied the migration on every load, so the output path became impossible to change.
   */
  private migrateFrom104(loaded: Record<string, unknown>): string | undefined {
    if (!("outputPath" in loaded) && !("maxFreeTasks" in loaded)) return undefined;

    const legacyPath = loaded.outputPath;
    let movedFrom: string | undefined;
    if (typeof legacyPath === "string" && legacyPath) {
      const check = validateOutputPath(legacyPath);
      if (check.ok) {
        // Keep it as the vault calendar so an existing user's imported feed does not move, and
        // put the current-note file beside it rather than at the new default.
        this.settings.vaultOutputPath = check.path;
        this.settings.currentNoteOutputPath = check.path.replace(/\.ics$/i, "-current-note.ics");
        this.settings.ownedPaths = [...new Set([...this.settings.ownedPaths, normalizeVaultPath(check.path)])];
      } else {
        // A 1.0.x path the new validation rejects cannot be kept, and moving a user's output
        // silently is exactly what this migration exists to avoid.
        movedFrom = legacyPath;
      }
    }

    const settings = this.settings as unknown as Record<string, unknown>;
    delete settings.outputPath;
    delete settings.maxFreeTasks;

    const moved = movedFrom
      ? ` Your old path "${movedFrom}" is no longer allowed (a calendar file must end in .ics), so the default is used instead.`
      : "";
    return (
      `Task Calendar Bridge now writes two files: ${this.settings.vaultOutputPath} for the whole vault and ` +
      `${this.settings.currentNoteOutputPath} for the current note.${moved} Event identity also changed — delete the calendar ` +
      `you imported before, then import the new file once. Importing on top of the old one duplicates every event.`
    );
  }

  /** Writes now, in order behind anything already queued. */
  async save(): Promise<void> {
    if (!this.canWrite()) return;
    await this.lane.enqueue(() => this.write());
  }

  /** Writes shortly. For values edited by typing, which used to write once per keystroke. */
  saveSoon(): void {
    if (!this.canWrite()) return;
    this.lane.schedule();
  }

  /** Pushes a pending write through — the settings tab closing must not lose a typed value. */
  async flush(): Promise<void> {
    this.lane.cancel();
    await this.save();
  }

  /** The write itself. The lane owns the ordering. */
  write(): Promise<void> {
    if (!this.canWrite()) return Promise.resolve();
    return this.data.save(this.settings);
  }

  private canWrite(): boolean {
    return this.alive() && !this.unreadable;
  }
}
