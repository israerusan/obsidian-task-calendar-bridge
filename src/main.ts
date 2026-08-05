import { Notice, Plugin, TFile, normalizePath, type Debouncer, debounce } from "obsidian";
import {
  FREE_TASK_LIMIT,
  compareTasks,
  describeAge,
  generateIcsCalendar,
  isInFolder,
  isSameFile,
  localToday,
  parseTasksFromMarkdown,
  selectUpcoming,
  splitFolders,
  validateOutputPath,
  type CalendarTask,
  type ParseOptions,
  type ParseResult,
  type SkippedTask,
} from "./core";
import { SAMPLE_TASK_NOTE } from "./core/help";
import { HelpModal } from "./HelpModal";
import { countSkips, ExportReportModal, type DuplicateIdentity, type ExportReport } from "./ExportReportModal";
import { LicenseManager } from "./license/LicenseManager";
import { isPublishSupported, publishCalendar, publishedFileExists } from "./publish";
import { DEFAULT_SETTINGS, TaskCalendarBridgeSettingTab, type TaskCalendarBridgeSettings } from "./settings";

/** How many skip records per reason are kept for display; `counts` carries the real totals. */
const REPORT_LIMIT_PER_REASON = 25;

interface CacheEntry {
  mtime: number;
  optionsKey: string;
  result: ParseResult;
}

export default class TaskCalendarBridgePlugin extends Plugin {
  settings: TaskCalendarBridgeSettings = { ...DEFAULT_SETTINGS };
  private autoExportDebounced?: Debouncer<[], void>;
  private saveSettingsDebounced?: Debouncer<[], void>;
  /** Serialises settings writes so an older snapshot cannot land last. */
  private saveQueue: Promise<unknown> = Promise.resolve();
  private statusBar?: HTMLElement;
  private lastReport: ExportReport | null = null;
  private parseCache = new Map<string, CacheEntry>();
  /**
   * Serialises whole exports — collect, generate, write, publish, and record.
   *
   * Queuing only the final write was not enough: a slow export that started
   * first could reach the queue last and put its stale snapshot on disk, then
   * overwrite the newer run's report and published copy with it.
   */
  private exportQueue: Promise<unknown> = Promise.resolve();
  /** One trailing auto-export is enough; a queue of them is just stale work. */
  private autoExportQueued = false;
  /** Content signature of what each output path was last written with. */
  private lastWritten = new Map<string, string>();
  /** Likewise for the copy outside the vault, tracked per destination. */
  private lastPublished = new Map<string, { signature: string; path: string }>();
  /** True when data.json exists but could not be read — see loadSettings. */
  settingsUnreadable = false;
  /** The free-tier upsell belongs in the report, not in every single notice. */
  private capNoticeShown = false;
  private unloaded = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.refreshLicense();

    this.statusBar = this.addStatusBarItem();
    this.renderStatusBar();

    this.autoExportDebounced = debounce(
      () => {
        if (this.unloaded) return;
        if (!this.settings.isPro || !this.settings.autoExport) return;
        // Coalesce: while one auto-export is running, further edits need exactly
        // one follow-up run, not one per edit. Without this a large vault could
        // spend minutes replaying snapshots that were stale before they started.
        if (this.autoExportQueued) return;
        this.autoExportQueued = true;
        void this.exportVaultTasks(false);
      },
      2000,
      true
    );

    this.addRibbonIcon("calendar-days", "Export tasks in this note to a calendar file", () => void this.exportCurrentNoteTasks(true));

    this.addCommand({
      id: "export-current-note-tasks",
      name: "Export current note tasks to ICS",
      callback: () => void this.exportCurrentNoteTasks(true),
    });

    this.addCommand({
      id: "export-vault-tasks",
      name: "Export vault tasks to ICS",
      callback: () => void this.exportVaultTasks(true),
    });

    this.addCommand({
      id: "copy-ics-path",
      name: "Copy calendar file path",
      callback: () => void this.copyOutputPath(),
    });

    this.addCommand({
      id: "show-export-report",
      name: "Show last export report",
      callback: () => this.showLastReport(),
    });

    this.addCommand({
      id: "open-import-guide",
      name: "Open calendar import guide",
      callback: () => this.openImportGuide(),
    });

    this.addCommand({
      id: "create-sample-task-note",
      name: "Create sample task note",
      callback: () => void this.createSampleTaskNote(),
    });

    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultChange(file.path, file instanceof TFile && file.extension === "md")));
    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultChange(file.path, file instanceof TFile && file.extension === "md")));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultChange(file.path, true)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.parseCache.delete(oldPath);
        this.onVaultChange(file.path, true);
      })
    );

    this.addSettingTab(new TaskCalendarBridgeSettingTab(this.app, this));

    this.showFirstRunGuidance();
  }

  /**
   * Enabling the plugin used to produce no visible sign of it whatsoever: an
   * empty status bar, one ribbon icon for the *current note*, and the whole-vault
   * export reachable only from a command palette nobody had been told to open.
   */
  private showFirstRunGuidance(): void {
    if (this.settings.hasOnboarded || this.settingsUnreadable) return;
    this.settings.hasOnboarded = true;
    void this.saveSettings();
    new Notice(
      "Task Calendar Bridge is ready. Run “Export vault tasks to ICS” from the command palette, or open Settings → Task Calendar Bridge for a sample note and the calendar setup guide.",
      12000
    );
  }

  onunload(): void {
    this.unloaded = true;
    // Without this the debounce can still fire after the plugin is disabled and
    // write a calendar file into a vault that no longer has the plugin loaded.
    this.autoExportDebounced?.cancel();
    // Same for the settings debounce: a pending write landing after unload would
    // overwrite whatever a freshly loaded instance had already saved.
    this.saveSettingsDebounced?.cancel();
    this.parseCache.clear();
    this.lastWritten.clear();
    this.lastPublished.clear();
  }

  private onVaultChange(path: string, relevant: boolean): void {
    this.parseCache.delete(path);
    if (!relevant) return;
    // Never react to the calendar files this plugin writes itself, nor to a note
    // the folder filters exclude — a whole-vault re-export triggered by an edit
    // inside an excluded folder cannot change a single byte of the output, and
    // it costs a full vault walk plus a rewrite of the published file every two
    // seconds for the length of a writing session.
    // `isSameFile` rather than `===`: the writer normalises the path, so an
    // invisible space or a decomposed accent used to make the plugin mistake its
    // own output for a user edit.
    if (!this.shouldIncludeFile(path)) return;
    this.autoExportDebounced?.();
  }

  // --- Exports ---------------------------------------------------------------

  async exportCurrentNoteTasks(showNotice: boolean): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Open a Markdown note before exporting its tasks.");
      return;
    }

    await this.runExport("current note", this.settings.currentNoteOutputPath, showNotice, async () => {
      const result = await this.parseFile(file);
      return { tasks: [...result.tasks].sort(compareTasks), skipped: result.skipped, totalFound: result.tasks.length, capped: 0 };
    });
  }

  async exportVaultTasks(showNotice: boolean): Promise<void> {
    await this.runExport("whole vault", this.settings.vaultOutputPath, showNotice, async () => {
      const all: CalendarTask[] = [];
      const skipped: SkippedTask[] = [];

      for (const file of this.app.vault.getMarkdownFiles()) {
        if (!this.shouldIncludeFile(file.path)) continue;
        const result = await this.parseFile(file);
        all.push(...result.tasks);
        skipped.push(...result.skipped);
      }

      if (this.settings.isPro) {
        return { tasks: all.sort(compareTasks), skipped, totalFound: all.length, capped: 0 };
      }

      const tasks = selectUpcoming(all, FREE_TASK_LIMIT, localToday());
      return { tasks, skipped, totalFound: all.length, capped: Math.max(0, all.length - tasks.length) };
    });
  }

  /**
   * Runs one export at a time, in the order they were asked for. Kept on a
   * settled branch so one failure cannot poison every later export.
   */
  private async runExport(
    scope: string,
    rawPath: string,
    showNotice: boolean,
    collect: () => Promise<{ tasks: CalendarTask[]; skipped: SkippedTask[]; totalFound: number; capped: number }>
  ): Promise<void> {
    const run = (): Promise<void> => this.runExportNow(scope, rawPath, showNotice, collect);
    const next = this.exportQueue.then(run, run);
    this.exportQueue = next.catch(() => undefined);
    await next;
  }

  private async runExportNow(
    scope: string,
    rawPath: string,
    showNotice: boolean,
    collect: () => Promise<{ tasks: CalendarTask[]; skipped: SkippedTask[]; totalFound: number; capped: number }>
  ): Promise<void> {
    // Released here, at the start of the run: an edit made *during* this export
    // must still schedule the trailing one that picks it up.
    this.autoExportQueued = false;
    if (this.unloaded) return;

    // Refusing to save data.json is not enough on its own. With settings we could
    // not read, `this.settings` is a set of invented defaults — the default output
    // path, no license, no publish folder, no folder filters — and exporting under
    // them would overwrite a Pro user's real calendar with a 25-event free-tier
    // stub. assertSafeTarget would wave it through, too, because the file it is
    // about to destroy is one of ours.
    if (this.settingsUnreadable) {
      new Notice(
        `Task Calendar Bridge will not export while it cannot read its settings: it would write over your calendar using default settings. Restore or fix ${this.dataPath()} and restart Obsidian.`,
        10000
      );
      return;
    }

    const check = validateOutputPath(rawPath);
    if (!check.ok) {
      await this.fail(scope, rawPath, check.error ?? "Invalid output path.");
      return;
    }

    // Compared case-insensitively: on Windows and macOS `Calendar/Tasks.ics`
    // and `calendar/tasks.ics` are one file, and each scope would overwrite the
    // other exactly as they did in 1.0.x.
    if (isSameFile(this.settings.vaultOutputPath, this.settings.currentNoteOutputPath)) {
      await this.fail(scope, rawPath, "The vault and current-note output paths are the same file. Give them different paths.");
      return;
    }

    try {
      const collected = await collect();
      const { ics, eventCount, duplicateIds } = generateIcsCalendar(collected.tasks, {
        calendarName: this.settings.calendarName,
        productId: "-//Task Calendar Bridge//EN",
        defaultDurationMinutes: this.settings.defaultDurationMinutes,
        timeMode: this.settings.timeMode,
        timeZone: this.settings.timeZone,
        allDayReminderTime: this.settings.allDayReminderTime,
        vaultName: this.app.vault.getName(),
        exportTags: this.settings.exportTags,
        linkToSource: this.settings.linkToSource,
      });

      const counts = countSkips(collected.skipped);
      const duplicates: DuplicateIdentity[] = duplicateIds.map((task) => ({ sourcePath: task.sourcePath, line: task.line, title: task.title }));

      const signature = icsSignature(ics);
      await this.writeIcs(check.path, ics, signature);

      // The vault write has succeeded by this point. A publishing problem is
      // reported alongside it, never as a failure of the export itself —
      // routing it through fail() told users nothing was written when the
      // calendar was in fact correct on disk.
      let publishedTo: string | undefined;
      let publishError: string | undefined;
      const inert = this.describeInertPublish();
      if (inert) {
        publishError = inert;
      } else {
        // Tracked separately from the vault write. Deriving "does the published
        // copy need updating?" from "did the vault file change?" would skip the
        // very first publish after someone turns publishing on, since the tasks
        // have not changed since the previous export.
        try {
          publishedTo = await this.publish(check.path, ics, signature);
        } catch (error) {
          publishError = describeError(error);
        }
      }

      if (this.unloaded) return;

      const report: ExportReport = {
        scope,
        path: check.path,
        eventCount,
        totalFound: collected.totalFound,
        capped: collected.capped,
        duplicateIds: duplicates,
        counts,
        // Capped, but sampled per bucket rather than off the front of one list.
        // Slicing the flat array meant a vault whose first 200 skips were all
        // completed tasks rendered "Not exported (37)" with no rows under it —
        // the one heading the report exists to explain, left empty.
        skipped: sampleSkips(collected.skipped),
        publishedTo,
        publishError,
        isPro: this.settings.isPro,
        freeLimit: FREE_TASK_LIMIT,
      };
      this.lastReport = report;
      this.settings.lastExport = {
        at: new Date().toISOString(),
        scope,
        path: check.path,
        eventCount,
        skippedCount: counts.lost,
        counts,
        duplicateIds: duplicates.slice(0, 50),
        publishError,
        // Persisted so "Show last export report" still works after a restart —
        // which is exactly when a user notices tasks missing from their calendar.
        skipped: sampleSkips(collected.skipped),
        totalFound: collected.totalFound,
        capped: collected.capped,
      };
      this.renderStatusBar();

      if (showNotice) new Notice(this.summarise(report), 8000);
    } catch (error) {
      await this.fail(scope, rawPath, describeError(error));
      return;
    }

    // Outside the try on purpose. The calendar file has already been written and
    // published correctly by this point, so a data.json write failure — a vault
    // in OneDrive holding the file open is enough — must not be reported as a
    // failed export, and must not discard the report of a run that succeeded.
    try {
      await this.saveSettings();
    } catch (error) {
      new Notice(`Task Calendar Bridge wrote the calendar, but could not save its own record of it: ${describeError(error)}`, 10000);
    }
  }

  private async fail(scope: string, path: string, message: string): Promise<void> {
    // A disabled plugin must not write to data.json or pop notices.
    if (this.unloaded) return;
    // Drop the stale report: showing the last *successful* run right after a
    // failure is worse than showing nothing.
    this.lastReport = null;
    this.settings.lastExport = { at: new Date().toISOString(), scope, path, eventCount: 0, skippedCount: 0, error: message };
    this.renderStatusBar();
    // 1.0.x launched every export with `void` and swallowed the rejection, so a
    // failed write looked exactly like a successful one.
    // Always surfaced, even for auto-export: a silent failure loop leaves the
    // calendar stale with nothing anywhere to explain it.
    // Shown BEFORE the save is attempted: when the save is what broke, awaiting
    // it first threw and the user was told nothing at all.
    new Notice(`Task Calendar Bridge: ${message}`, 10000);
    try {
      await this.saveSettings();
    } catch {
      // Already reported above; a second failure has nothing new to tell anyone.
    }
  }

  /** Every Pro gate that changes what the parser produces, in one place. */
  private parseOptions(): ParseOptions {
    return {
      includeCompleted: this.settings.isPro && this.settings.includeCompleted,
      includeRecurrence: this.settings.isPro && this.settings.includeRecurrence,
      includeReminders: this.settings.isPro && this.settings.includeReminders,
    };
  }

  private async parseFile(file: TFile): Promise<ParseResult> {
    const options = this.parseOptions();
    const optionsKey = `${options.includeCompleted}|${options.includeRecurrence}|${options.includeReminders}`;
    const cached = this.parseCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime && cached.optionsKey === optionsKey) return cached.result;

    // Sample mtime *before* reading. Reading it afterwards paired the new mtime
    // with old content when the note changed mid-export, caching stale tasks.
    const mtime = file.stat.mtime;
    const markdown = await this.app.vault.cachedRead(file);
    const result = parseTasksFromMarkdown(markdown, file.path, options);
    this.parseCache.set(file.path, { mtime, optionsKey, result });
    this.trimParseCache();
    return result;
  }

  /**
   * A bound on the cache.
   *
   * One entry per markdown file is unbounded by design, and each entry holds
   * every task and skip record the file produced. A vault of tens of thousands
   * of notes is a real amount of retained memory for a cache whose only job is
   * to make the *next* export cheap.
   */
  private trimParseCache(): void {
    const limit = 5000;
    if (this.parseCache.size <= limit) return;
    // Map iterates in insertion order, so the oldest entries go first.
    for (const key of this.parseCache.keys()) {
      this.parseCache.delete(key);
      if (this.parseCache.size <= limit) break;
    }
  }

  /** Ordering comes from the export queue, which serialises the whole pipeline. */
  private async writeIcs(path: string, ics: string, signature: string): Promise<void> {
    // onunload only cancels the pending debounce; an export already in flight
    // reaches here seconds later and would otherwise write into a vault whose
    // plugin instance is gone, clobbering the live instance's data.json.
    if (this.unloaded) return;
    const target = normalizePath(path);
    await this.assertSafeTarget(target);

    // Two exports of unchanged tasks differ only in DTSTAMP, so that is what the
    // comparison ignores. Rewriting an identical calendar costs a vault write, a
    // mtime change every sync client uploads, and a fresh download for everyone
    // subscribed to it — for a file whose meaning did not change.
    // The existence check matters: without it, deleting the calendar file by hand
    // would never bring it back, because the plugin still believed it was current.
    if (this.lastWritten.get(target) === signature && (await this.app.vault.adapter.exists(target))) return;

    await this.ensureParentFolder(target);
    await this.app.vault.adapter.write(target, ics);
    this.lastWritten.set(target, signature);
    if (!this.settings.ownedPaths.includes(target)) {
      this.settings.ownedPaths.push(target);
    }
  }

  /** Refuse to overwrite a file this plugin did not create. */
  private async assertSafeTarget(path: string): Promise<void> {
    if (this.settings.ownedPaths.includes(path)) return;
    if (!(await this.app.vault.adapter.exists(path))) return;

    // Ownership records live in data.json; a reinstall loses them. A file that
    // is already one of our calendars is still ours, so read before refusing.
    try {
      const existing = await this.app.vault.adapter.read(path);
      if (existing.startsWith("BEGIN:VCALENDAR") && existing.includes("Task Calendar Bridge")) return;
    } catch {
      // Unreadable means we cannot prove it is ours, so fall through and refuse.
    }

    throw new Error(`${path} already exists and was not created by this plugin. Choose another output path.`);
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    if (parts.length === 0) return;

    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  /**
   * Publishing that is switched on but no longer running, described.
   *
   * Removing a license turned publishing into a silent no-op while the copy in
   * the cloud folder stayed exactly as it was — so a calendar other people had
   * subscribed to went on serving stale events indefinitely, with nothing in the
   * notice, the report, or the settings tab to say the plugin had stopped
   * updating it.
   */
  private describeInertPublish(): string | undefined {
    if (!this.settings.publishEnabled) return undefined;
    if (this.settings.isPro) return undefined;
    const target = this.settings.publishPath.trim();
    return `Publishing outside the vault is a Pro feature and is no longer running${target ? `, so the copy in ${target} is out of date` : ""}. Turn off "Publish outside the vault", or reactivate Pro.`;
  }

  private async publish(vaultPath: string, ics: string, signature: string): Promise<string | undefined> {
    if (this.unloaded) return undefined;
    if (!this.settings.isPro || !this.settings.publishEnabled) return undefined;
    if (!this.settings.publishPath.trim()) throw new Error('Publishing is on but no publish folder is set.');
    if (!isPublishSupported()) throw new Error("Publishing outside the vault only works on desktop.");
    // Flattened from the whole vault path, not just the basename: two scopes
    // ending in the same file name would otherwise publish over each other.
    const fileName = vaultPath.replace(/\//g, "-");
    // Keyed on the destination as well as the file, so changing the publish
    // folder republishes rather than being mistaken for "already up to date".
    const key = `${this.settings.publishPath.trim()} :: ${fileName}`;
    const known = this.lastPublished.get(key);
    // Same existence check the vault write does: without it, deleting the
    // published copy would never bring it back, because the plugin still
    // believed the file it had written was sitting there.
    if (known && known.signature === signature && (await publishedFileExists(known.path))) return known.path;

    const published = await publishCalendar(this.settings.publishPath, fileName, ics);
    this.lastPublished.set(key, { signature, path: published });
    return published;
  }

  private shouldIncludeFile(path: string): boolean {
    if (isSameFile(path, this.settings.vaultOutputPath) || isSameFile(path, this.settings.currentNoteOutputPath)) return false;

    // Exclusions apply whether or not Pro is active. Gating them on isPro made
    // losing a license *add* content: a user who had excluded Archive and
    // Templates suddenly found hundreds of old tasks and template placeholders
    // in their calendar. Turning a paid feature off must never widen the output.
    const excludes = splitFolders(this.settings.excludeFolders);
    if (excludes.some((folder) => isInFolder(path, folder))) return false;

    // An include list is a genuine Pro capability, so it lapses with the license.
    if (!this.settings.isPro) return true;
    const includes = splitFolders(this.settings.includeFolders);
    // Boundary matching: "Work" must not also select "Workshop/notes.md".
    if (includes.length > 0 && !includes.some((folder) => isInFolder(path, folder))) return false;
    return true;
  }

  // --- License and settings --------------------------------------------------

  /**
   * Always saves: `activate()` sets `licenseKey` and then calls this to make the
   * change durable, so skipping the write when the derived Pro state happens to
   * be unchanged would silently fail to persist a replacement key.
   */
  async refreshLicense(): Promise<void> {
    const result = this.settings.licenseKey ? LicenseManager.verify(this.settings.licenseKey) : undefined;
    this.settings.isPro = result?.valid ?? false;
    this.settings.licenseEmail = (result?.valid ? result.email : undefined) ?? "";
    await this.saveSettings();
  }

  async loadSettings(): Promise<void> {
    const data: unknown = await this.loadData();

    // `loadData()` returns null for "there is no data.json yet" and for "data.json
    // is there but could not be read or parsed" alike — a force-quit mid-write, a
    // cloud-sync conflict, or a file the OS still has open. Only the second is
    // dangerous: treating it as a first run makes refreshLicense write the
    // defaults straight back over it, and the user's ONLY copy of the Pro key
    // they paid for is gone. So when the file exists, refuse to write anything.
    if (data === null && (await this.dataFileExists())) {
      this.settingsUnreadable = true;
      this.settings = { ...DEFAULT_SETTINGS };
      new Notice(
        `Task Calendar Bridge could not read its settings file, so it has not changed anything. Your license key and settings are still in ${this.dataPath()} — restore or fix that file and restart Obsidian. Nothing will be saved until then.`,
        0
      );
      return;
    }

    const loaded = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

    if (!Array.isArray(this.settings.ownedPaths)) this.settings.ownedPaths = [];
    // The checkout link is a constant now; a persisted copy would outrank it
    // forever and freeze every install on the URL it first shipped with.
    delete (this.settings as unknown as Record<string, unknown>).purchaseUrl;
    await this.migrateFrom104(loaded);
  }

  /**
   * Where this plugin's data.json lives. Built from `manifest.dir` — or from
   * `vault.configDir` when that is unset — because the config folder is not
   * always `.obsidian`; users can and do rename it.
   */
  dataPath(): string {
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return normalizePath(`${dir}/data.json`);
  }

  private async dataFileExists(): Promise<boolean> {
    try {
      return await this.app.vault.adapter.exists(this.dataPath());
    } catch {
      // Cannot tell. Assume it is there: refusing to save is recoverable, and
      // overwriting a license key is not.
      return true;
    }
  }

  /**
   * 1.0.x kept a single `outputPath` that both export scopes wrote to. Keep it
   * as the vault calendar so an existing user's imported feed does not move,
   * and put the current-note file beside it rather than at the new default —
   * the ribbon icon writes there, and silently retargeting it would leave the
   * feed the user already subscribed to frozen.
   *
   * Runs exactly once: the legacy keys are consumed and deleted. Leaving them in
   * data.json re-applied the migration on every load, so the output path became
   * impossible to change.
   */
  private async migrateFrom104(loaded: Record<string, unknown>): Promise<void> {
    const legacyPath = loaded.outputPath;
    const hasLegacy = "outputPath" in loaded || "maxFreeTasks" in loaded;
    if (!hasLegacy) return;

    let movedFrom: string | undefined;
    if (typeof legacyPath === "string" && legacyPath) {
      const check = validateOutputPath(legacyPath);
      if (check.ok) {
        this.settings.vaultOutputPath = check.path;
        this.settings.currentNoteOutputPath = check.path.replace(/\.ics$/i, "-current-note.ics");
        this.settings.ownedPaths = [...new Set([...this.settings.ownedPaths, normalizePath(check.path)])];
      } else {
        // A 1.0.x path the new validation rejects cannot be kept, and moving a
        // user's output silently is exactly what this migration exists to avoid.
        movedFrom = legacyPath;
      }
    }

    const settings = this.settings as unknown as Record<string, unknown>;
    delete settings.outputPath;
    delete settings.maxFreeTasks;
    await this.saveSettings();

    const moved = movedFrom
      ? ` Your old path "${movedFrom}" is no longer allowed (a calendar file must end in .ics), so the default is used instead.`
      : "";
    new Notice(
      `Task Calendar Bridge now writes two files: ${this.settings.vaultOutputPath} for the whole vault and ${this.settings.currentNoteOutputPath} for the current note.${moved} Event identity also changed — delete the calendar you imported before, then import the new file once. Importing on top of the old one duplicates every event.`,
      15000
    );
  }

  async saveSettings(): Promise<void> {
    if (this.unloaded) return;
    // Writing defaults over a data.json we could not read is exactly how a paid
    // license key gets destroyed, so nothing is saved until it is fixed.
    if (this.settingsUnreadable) return;
    // Serialised: `saveData` snapshots the settings synchronously but the writes
    // complete in whatever order they finish, so two unawaited saves could leave
    // an older snapshot as the last thing on disk.
    const run = (): Promise<void> => this.saveData(this.settings);
    const next = this.saveQueue.then(run, run);
    this.saveQueue = next.catch(() => undefined);
    await next;
  }

  /**
   * For settings edited by typing.
   *
   * Every text field saved on each keystroke, and data.json carries the last
   * export's skip records — tens of kilobytes — so typing a folder path wrote
   * the whole blob once per character, and every one of those writes is a change
   * inside the config folder that Obsidian Sync then uploads.
   */
  saveSettingsSoon(): void {
    this.saveSettingsDebounced ??= debounce(() => void this.saveSettings(), 500, true);
    this.saveSettingsDebounced();
  }

  /** Flushes any pending debounced save. Called when the settings tab closes. */
  async flushSettings(): Promise<void> {
    this.saveSettingsDebounced?.cancel();
    await this.saveSettings();
  }

  // --- UI --------------------------------------------------------------------

  private renderStatusBar(): void {
    if (!this.statusBar) return;
    const last = this.settings.lastExport;
    if (!last) {
      this.statusBar.setText("");
      this.statusBar.setAttr("aria-label", "");
      return;
    }
    if (last.error) {
      this.statusBar.setText("Calendar export failed");
      this.statusBar.setAttr("aria-label", `Task Calendar Bridge: ${last.error}`);
      return;
    }
    // "Is my calendar up to date?" is the whole question for a file-based
    // calendar bridge, and the answer was nowhere in the plugin: a count from
    // three weeks ago survives a restart and reads exactly like a fresh one.
    const age = describeAge(last.at);
    this.statusBar.setText(`Calendar: ${last.eventCount} event${last.eventCount === 1 ? "" : "s"}${age ? ` · ${age}` : ""}`);
    this.statusBar.setAttr("aria-label", `Task Calendar Bridge exported ${last.eventCount} events to ${last.path}${age ? ` ${age}` : ""}`);
  }

  showLastReport(): void {
    // Rebuilt from the persisted record when the in-memory one is gone. Telling
    // a user "run an export first" right after the settings tab told them two
    // tasks were skipped is the worst possible moment to lose the report.
    const report = this.lastReport ?? this.reportFromSettings();
    if (!report) {
      new Notice("Run an export first, then the report will show what was included and skipped.");
      return;
    }
    new ExportReportModal(this.app, report).open();
  }

  private reportFromSettings(): ExportReport | null {
    const last = this.settings.lastExport;
    if (!last || last.error) return null;
    return {
      scope: last.scope,
      path: last.path,
      eventCount: last.eventCount,
      totalFound: last.totalFound ?? last.eventCount,
      capped: last.capped ?? 0,
      duplicateIds: last.duplicateIds ?? [],
      skipped: last.skipped ?? [],
      // Recounted from the sample for records written before counts were
      // persisted, so an upgrade does not show a report with everything at zero.
      counts: last.counts ?? countSkips(last.skipped ?? []),
      publishError: last.publishError,
      isPro: this.settings.isPro,
      freeLimit: FREE_TASK_LIMIT,
    };
  }

  /**
   * Copies the path of the calendar that was actually written.
   *
   * It always copied the whole-vault path, but the ribbon icon — the most
   * discoverable entry point there is — writes the *current-note* file, so a
   * user who had only ever clicked the ribbon was handed a path to a file that
   * did not exist and pasted it into their calendar app.
   */
  private async copyOutputPath(): Promise<void> {
    const last = this.settings.lastExport;
    const path = last && !last.error ? last.path : this.settings.vaultOutputPath;
    const scope = last && !last.error ? ` (${last.scope})` : "";
    try {
      await navigator.clipboard.writeText(path);
      new Notice(`Copied ${path}${scope}`);
    } catch {
      new Notice(path);
    }
  }

  openImportGuide(): void {
    new HelpModal(this.app).open();
  }

  /**
   * Two sentences: what happened, and the single most important thing to know
   * about it. Everything else belongs in the report the second sentence points at
   * — a 300-character toast that repeats the same upsell on export number two
   * hundred trains people to dismiss the notice without reading it, which is
   * precisely where the actionable errors live.
   */
  private summarise(report: ExportReport): string {
    const headline = `Exported ${report.eventCount} event${report.eventCount === 1 ? "" : "s"} to ${report.path}.`;

    // A publish failure outranks everything: the calendar on disk is right, but
    // the copy people have subscribed to is not.
    if (report.publishError) return `${headline} Publishing outside the vault failed: ${report.publishError}`;

    if (report.eventCount === 0) {
      return `${headline} It has no events, and most calendar apps refuse to import an empty calendar — check “Show last export report”.`;
    }

    // Only genuine losses are counted. Completed tasks are excluded on purpose,
    // and an ignored field still produced an event — reporting either as "could
    // not be exported" made a perfectly healthy export read like a failure.
    const lost = report.counts.lost;
    if (lost > 0) {
      return `${headline} ${lost} task${lost === 1 ? "" : "s"} could not be exported — run “Show last export report” for details.`;
    }

    if (report.capped > 0 && !this.capNoticeShown) {
      this.capNoticeShown = true;
      return `${headline} Your vault has ${report.totalFound} dated tasks; the free tier exports the next ${report.freeLimit}. See the export report to unlock the rest.`;
    }

    const warnings = report.counts.warnings;
    if (warnings > 0) {
      return `${headline} ${warnings} task${warnings === 1 ? "" : "s"} exported with a field ignored — see the export report.`;
    }

    return report.publishedTo ? `${headline} Also published to ${report.publishedTo}.` : headline;
  }

  async createSampleTaskNote(): Promise<void> {
    const basePath = "Task Calendar Bridge Sample.md";
    let path = basePath;
    let counter = 2;
    while (await this.app.vault.adapter.exists(path)) {
      path = `Task Calendar Bridge Sample ${counter}.md`;
      counter++;
    }
    const file = await this.app.vault.create(path, SAMPLE_TASK_NOTE);
    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice(`Created ${path}`);
  }
}



function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A bounded sample that still has rows for every reason present.
 *
 * The report groups skips by reason and shows a handful of each, so the sample
 * has to be taken per reason: a flat slice of the first N was all "completed" in
 * any real vault, leaving the "Not exported" heading — the entire point of the
 * report — with a count and nothing under it.
 */
function sampleSkips(skipped: SkippedTask[]): SkippedTask[] {
  const perReason = new Map<string, SkippedTask[]>();
  for (const item of skipped) {
    const bucket = perReason.get(item.reason) ?? [];
    if (bucket.length < REPORT_LIMIT_PER_REASON) bucket.push(item);
    perReason.set(item.reason, bucket);
  }
  return [...perReason.values()].flat();
}

/** The calendar's content, minus the one property that changes on every run. */
function icsSignature(ics: string): string {
  return ics.replace(/DTSTAMP:[^\r\n]*/g, "");
}

