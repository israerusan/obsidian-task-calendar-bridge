import { Notice, Plugin, TFile, normalizePath, type Debouncer, debounce } from "obsidian";
import {
  FREE_TASK_LIMIT,
  compareTasks,
  generateIcsCalendar,
  isInFolder,
  localToday,
  parseTasksFromMarkdown,
  selectUpcoming,
  splitFolders,
  validateOutputPath,
  type CalendarTask,
  type ParseResult,
  type SkippedTask,
} from "./core";
import { SAMPLE_TASK_NOTE } from "./core/help";
import { HelpModal } from "./HelpModal";
import { ExportReportModal, type ExportReport } from "./ExportReportModal";
import { LicenseManager } from "./license/LicenseManager";
import { isPublishSupported, publishCalendar } from "./publish";
import { DEFAULT_SETTINGS, TaskCalendarBridgeSettingTab, type TaskCalendarBridgeSettings } from "./settings";

interface CacheEntry {
  mtime: number;
  optionsKey: string;
  result: ParseResult;
}

export default class TaskCalendarBridgePlugin extends Plugin {
  settings: TaskCalendarBridgeSettings = { ...DEFAULT_SETTINGS };
  private autoExportDebounced?: Debouncer<[], void>;
  private statusBar?: HTMLElement;
  private lastReport: ExportReport | null = null;
  private parseCache = new Map<string, CacheEntry>();
  /** Serialises writes so two exports can never interleave on one file. */
  private writeQueue: Promise<unknown> = Promise.resolve();
  private unloaded = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.refreshLicense();

    this.statusBar = this.addStatusBarItem();
    this.renderStatusBar();

    this.autoExportDebounced = debounce(
      () => {
        if (this.unloaded) return;
        if (this.settings.isPro && this.settings.autoExport) void this.exportVaultTasks(false);
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
  }

  onunload(): void {
    this.unloaded = true;
    // Without this the debounce can still fire after the plugin is disabled and
    // write a calendar file into a vault that no longer has the plugin loaded.
    this.autoExportDebounced?.cancel();
    this.parseCache.clear();
  }

  private onVaultChange(path: string, relevant: boolean): void {
    this.parseCache.delete(path);
    if (!relevant) return;
    // Never react to the calendar files this plugin writes itself.
    if (path === this.settings.vaultOutputPath || path === this.settings.currentNoteOutputPath) return;
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

  private async runExport(
    scope: string,
    rawPath: string,
    showNotice: boolean,
    collect: () => Promise<{ tasks: CalendarTask[]; skipped: SkippedTask[]; totalFound: number; capped: number }>
  ): Promise<void> {
    const check = validateOutputPath(rawPath);
    if (!check.ok) {
      await this.fail(scope, rawPath, check.error ?? "Invalid output path.");
      return;
    }

    // Compared case-insensitively: on Windows and macOS `Calendar/Tasks.ics`
    // and `calendar/tasks.ics` are one file, and each scope would overwrite the
    // other exactly as they did in 1.0.x.
    if (sameFile(this.settings.vaultOutputPath, this.settings.currentNoteOutputPath)) {
      await this.fail(scope, rawPath, "The vault and current-note output paths are the same file. Give them different paths.");
      return;
    }

    try {
      const collected = await collect();
      const { ics, eventCount, duplicateIds } = generateIcsCalendar(collected.tasks, {
        calendarName: this.settings.calendarName,
        productId: "-//Task Calendar Bridge//EN",
        includeReminders: this.settings.isPro && this.settings.includeReminders,
        defaultDurationMinutes: this.settings.defaultDurationMinutes,
        timeMode: this.settings.timeMode,
        timeZone: this.settings.timeZone,
        allDayReminderTime: this.settings.allDayReminderTime,
        vaultName: this.app.vault.getName(),
        exportTags: this.settings.exportTags,
      });

      await this.writeIcs(check.path, ics);

      // The vault write has succeeded by this point. A publishing problem is
      // reported alongside it, never as a failure of the export itself —
      // routing it through fail() told users nothing was written when the
      // calendar was in fact correct on disk.
      let publishedTo: string | undefined;
      let publishError: string | undefined;
      try {
        publishedTo = await this.publish(check.path, ics);
      } catch (error) {
        publishError = describeError(error);
      }

      if (this.unloaded) return;

      const report: ExportReport = {
        scope,
        path: check.path,
        eventCount,
        totalFound: collected.totalFound,
        capped: collected.capped,
        duplicateIds: duplicateIds.length,
        skipped: collected.skipped,
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
        skippedCount: collected.skipped.length,
        publishError,
        // Persisted so "Show last export report" still works after a restart —
        // which is exactly when a user notices tasks missing from their calendar.
        skipped: collected.skipped.slice(0, 200),
        totalFound: collected.totalFound,
        capped: collected.capped,
      };
      await this.saveSettings();
      this.renderStatusBar();

      if (showNotice) new Notice(summarise(report), 8000);
    } catch (error) {
      await this.fail(scope, rawPath, describeError(error));
    }
  }

  private async fail(scope: string, path: string, message: string): Promise<void> {
    // A disabled plugin must not write to data.json or pop notices.
    if (this.unloaded) return;
    // Drop the stale report: showing the last *successful* run right after a
    // failure is worse than showing nothing.
    this.lastReport = null;
    this.settings.lastExport = { at: new Date().toISOString(), scope, path, eventCount: 0, skippedCount: 0, error: message };
    await this.saveSettings();
    this.renderStatusBar();
    // 1.0.x launched every export with `void` and swallowed the rejection, so a
    // failed write looked exactly like a successful one.
    // Always surfaced, even for auto-export: a silent failure loop leaves the
    // calendar stale with nothing anywhere to explain it.
    new Notice(`Task Calendar Bridge: ${message}`, 10000);
  }

  private async parseFile(file: TFile): Promise<ParseResult> {
    const optionsKey = `${this.settings.isPro && this.settings.includeCompleted}|${this.settings.isPro && this.settings.includeRecurrence}`;
    const cached = this.parseCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime && cached.optionsKey === optionsKey) return cached.result;

    // Sample mtime *before* reading. Reading it afterwards paired the new mtime
    // with old content when the note changed mid-export, caching stale tasks.
    const mtime = file.stat.mtime;
    const markdown = await this.app.vault.cachedRead(file);
    const result = parseTasksFromMarkdown(markdown, file.path, {
      includeCompleted: this.settings.isPro && this.settings.includeCompleted,
      includeRecurrence: this.settings.isPro && this.settings.includeRecurrence,
    });
    this.parseCache.set(file.path, { mtime, optionsKey, result });
    return result;
  }

  private async writeIcs(path: string, ics: string): Promise<void> {
    const run = async (): Promise<void> => {
      // onunload only cancels the pending debounce; an export already in flight
      // reaches here seconds later and would otherwise write into a vault whose
      // plugin instance is gone, clobbering the live instance's data.json.
      if (this.unloaded) return;
      const target = normalizePath(path);
      await this.assertSafeTarget(target);
      await this.ensureParentFolder(target);
      await this.app.vault.adapter.write(target, ics);
      if (!this.settings.ownedPaths.includes(target)) {
        this.settings.ownedPaths.push(target);
        await this.saveSettings();
      }
    };

    // One queue for every write: `exists()` then `create()` raced against itself
    // when two exports overlapped and threw "file already exists". The queue is
    // kept on a settled branch so one failure cannot poison every later write.
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.catch(() => undefined);
    await next;
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

  private async publish(vaultPath: string, ics: string): Promise<string | undefined> {
    if (this.unloaded) return undefined;
    if (!this.settings.isPro || !this.settings.publishEnabled) return undefined;
    if (!this.settings.publishPath.trim()) throw new Error('Publishing is on but no publish folder is set.');
    if (!isPublishSupported()) throw new Error("Publishing outside the vault only works on desktop.");
    // Flattened from the whole vault path, not just the basename: two scopes
    // ending in the same file name would otherwise publish over each other.
    const fileName = vaultPath.replace(/\//g, "-");
    return publishCalendar(this.settings.publishPath, fileName, ics);
  }

  private shouldIncludeFile(path: string): boolean {
    if (path === this.settings.vaultOutputPath || path === this.settings.currentNoteOutputPath) return false;
    if (!this.settings.isPro) return true;

    const includes = splitFolders(this.settings.includeFolders);
    const excludes = splitFolders(this.settings.excludeFolders);
    // Boundary matching: "Work" must not also select "Workshop/notes.md".
    if (includes.length > 0 && !includes.some((folder) => isInFolder(path, folder))) return false;
    if (excludes.some((folder) => isInFolder(path, folder))) return false;
    return true;
  }

  // --- License and settings --------------------------------------------------

  async refreshLicense(): Promise<void> {
    if (!this.settings.licenseKey) {
      this.settings.isPro = false;
      this.settings.licenseEmail = "";
      await this.saveSettings();
      return;
    }
    const result = LicenseManager.verify(this.settings.licenseKey);
    this.settings.isPro = result.valid;
    this.settings.licenseEmail = result.email ?? "";
    await this.saveSettings();
  }

  async loadSettings(): Promise<void> {
    const data: unknown = await this.loadData();
    const loaded = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

    if (!Array.isArray(this.settings.ownedPaths)) this.settings.ownedPaths = [];
    await this.migrateFrom104(loaded);
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
    await this.saveData(this.settings);
  }

  // --- UI --------------------------------------------------------------------

  private renderStatusBar(): void {
    if (!this.statusBar) return;
    const last = this.settings.lastExport;
    if (!last) {
      this.statusBar.setText("");
      return;
    }
    this.statusBar.setText(last.error ? "Calendar export failed" : `Calendar: ${last.eventCount} event${last.eventCount === 1 ? "" : "s"}`);
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
      duplicateIds: 0,
      skipped: last.skipped ?? [],
      publishError: last.publishError,
      isPro: this.settings.isPro,
      freeLimit: FREE_TASK_LIMIT,
    };
  }

  private async copyOutputPath(): Promise<void> {
    const path = this.settings.vaultOutputPath;
    try {
      await navigator.clipboard.writeText(path);
      new Notice(`Copied ${path}`);
    } catch {
      new Notice(path);
    }
  }

  openImportGuide(): void {
    new HelpModal(this.app).open();
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

function summarise(report: ExportReport): string {
  const parts = [`Exported ${report.eventCount} event${report.eventCount === 1 ? "" : "s"} to ${report.path}.`];
  if (report.capped > 0) {
    parts.push(`The free tier exported ${report.eventCount} of ${report.totalFound} dated tasks; ${report.capped} more need Pro.`);
  }
  // Only genuine losses are counted. Completed tasks are excluded on purpose,
  // and an ignored field still produced an event — reporting either as "could
  // not be exported" made a perfectly healthy export read like a failure.
  const lost = report.skipped.filter((item) => item.fatal && item.reason !== "completed" && item.reason !== "cancelled");
  const warnings = report.skipped.filter((item) => !item.fatal);
  if (lost.length > 0) {
    parts.push(`${lost.length} task${lost.length === 1 ? "" : "s"} could not be exported — run “Show last export report” for details.`);
  } else if (warnings.length > 0) {
    parts.push(`${warnings.length} task${warnings.length === 1 ? "" : "s"} exported with a field ignored — see the export report.`);
  }
  if (report.eventCount === 0) {
    parts.push("The file has no events, and most calendar apps refuse to import an empty calendar.");
  }
  if (report.publishedTo) parts.push(`Published to ${report.publishedTo}.`);
  if (report.publishError) parts.push(`Publishing failed: ${report.publishError}`);
  return parts.join(" ");
}

/** Vault paths are case-insensitive on the platforms Obsidian runs on. */
function sameFile(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
