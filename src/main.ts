import { Menu, Notice, Platform, Plugin, TFile, apiVersion, normalizePath, type Editor } from "obsidian";
import {
  FREE_TASK_LIMIT,
  compareTasks,
  describeAge,
  isNewerVersion,
  isTaskLine,
  localToday,
  notesSince,
  shouldIncludeNote,
  countSkips,
  type CalendarTask,
  type ExportReport,
  type FolderFilter,
  type ParseOptions,
  type SkippedTask,
} from "./core";
import {
  buildCalendar,
  buildDiagnostics,
  buildPreview,
  explainLine,
  isCalendarCurrent,
  ParseIndex,
  SettingsStore,
  TaskLane,
  CalendarWriter,
  entitlements,
  planReport,
  precheckExport,
  selectForExport,
  summariseExport,
  type CalendarOptions,
  type CalendarPreview,
  type Entitlements,
  type PreviewItem,
} from "./app";
import { SAMPLE_TASK_NOTE } from "./core/help";
import { HelpModal } from "./HelpModal";
import { ExportReportModal } from "./ExportReportModal";
import { LicenseManager } from "./license/LicenseManager";
import { isPublishSupported, publishCalendar, publishedFileExists } from "./publish";
import { TaskCalendarBridgeSettingTab } from "./settings/SettingsTab";
import { PURCHASE_URL, type TaskCalendarBridgeSettings } from "./settings/schema";
import { CALENDAR_VIEW_TYPE, TaskCalendarView, type CalendarViewHost, type PreviewSnapshot } from "./view/CalendarView";
import { openTaskSource } from "./ui/openSource";
import { WhatsNewModal } from "./ui/WhatsNewModal";
import { ExplainModal } from "./ui/ExplainModal";

export default class TaskCalendarBridgePlugin extends Plugin {
  private store!: SettingsStore;
  /** Auto-export: debounced, coalesced, serialised, cancellable — one concept. */
  private exportLane!: TaskLane;
  /** Settings writes, on the same terms. Typing a path wrote data.json per keystroke. */
  private saveLane!: TaskLane;
  private statusBar?: HTMLElement;
  private lastReport: ExportReport | null = null;
  private notes!: ParseIndex;
  /** Owns both destinations, and the one rule they share. */
  private writer!: CalendarWriter;
  /** The free-tier upsell belongs in the report, not in every single notice. */
  private capNoticeShown = false;
  private unloaded = false;
  /** Exports currently running, so the calendar view can say "Updating…" rather than "Out of date". */
  private exportsRunning = 0;
  /** The day the calendar views were last drawn for; they redraw when it changes. */
  private viewDay = localToday();

  async onload(): Promise<void> {
    // window.* rather than bare timers, so a lane still fires in a popped-out window.
    const timer = { set: (fn: () => void, ms: number) => window.setTimeout(fn, ms), clear: (handle: unknown) => window.clearTimeout(handle as number) };
    this.saveLane = new TaskLane({
      timer,
      delayMs: 500,
      alive: () => !this.unloaded,
      run: () => this.store.write(),
      // Every text field in the settings tab saves through here. Without this the failure is an
      // unhandled rejection and the setting silently reverts at the next restart.
      onError: (error) => new Notice(`Task Calendar Bridge could not save its settings: ${describeError(error)}`, 10000),
    });
    this.store = new SettingsStore(
      {
        load: () => this.loadData(),
        save: (settings) => this.saveData(settings),
        path: () => this.dataPath(),
        exists: (path) => this.app.vault.adapter.exists(path),
      },
      this.saveLane,
      () => !this.unloaded
    );

    this.writer = new CalendarWriter(
      {
        normalize: (target) => normalizePath(target),
        exists: (target) => this.app.vault.adapter.exists(target),
        read: (target) => this.app.vault.adapter.read(target),
        write: (target, contents) => this.app.vault.adapter.write(target, contents),
        mkdir: (target) => this.app.vault.adapter.mkdir(target),
      },
      {
        available: () => isPublishSupported(),
        exists: (fullPath) => publishedFileExists(fullPath),
        write: (folder, fileName, contents) => publishCalendar(folder, fileName, contents),
      },
      { alive: () => !this.unloaded },
      {
        has: (target) => this.settings.ownedPaths.includes(target),
        add: (target) => this.settings.ownedPaths.push(target),
      }
    );

    this.exportLane = new TaskLane({
      timer,
      delayMs: 2000,
      alive: () => !this.unloaded,
      onError: (error) => new Notice(`Task Calendar Bridge: ${describeError(error)}`, 10000),
      run: async () => {
        // Checked when the run starts, not when it was scheduled: a licence can lapse in
        // between, and a lapsed one must not keep exporting on its own.
        if (!this.entitlements().autoExport) return;
        await this.vaultExport(false);
      },
    });
    this.notes = new ParseIndex({ read: (note) => this.app.vault.cachedRead(this.mustBeFile(note.path)) });

    // Only now does anything touch the disk. Everything above is wiring.
    const outcome = await this.store.load();
    if (outcome.notice) new Notice(outcome.notice, outcome.unreadable ? 0 : 15000);
    await this.refreshLicense();

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("mod-clickable");
    this.registerDomEvent(this.statusBar, "click", (event) => this.showStatusMenu(event));
    this.renderStatusBar();


    this.registerView(CALENDAR_VIEW_TYPE, (leaf) => new TaskCalendarView(leaf, this.viewHost()));
    this.addRibbonIcon("calendar-days", "Open task calendar", () => void this.openCalendarView());

    this.addCommand({
      id: "open-calendar-view",
      name: "Open task calendar",
      callback: () => void this.openCalendarView(),
    });

    this.addCommand({
      id: "export-current-note-tasks",
      name: "Export current note tasks to ICS",
      // Offered only where it can work, rather than offered everywhere and then refusing.
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.exportNoteTasks(file, true);
        return true;
      },
    });

    this.addCommand({
      id: "explain-task-event",
      name: "Explain this task's calendar event",
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        if (!file || !isTaskLine(editor.getLine(editor.getCursor().line))) return false;
        if (!checking) void this.explainEditorLine(editor, file);
        return true;
      },
    });

    this.addCommand({
      id: "show-whats-new",
      name: "Show what's new",
      callback: () => this.showWhatsNew(),
    });

    this.addCommand({
      id: "copy-diagnostics",
      name: "Copy diagnostics for a bug report",
      callback: () => void this.copyDiagnostics(),
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
        this.notes.forget(oldPath);
        this.onVaultChange(file.path, true);
      })
    );

    // Export one note from wherever notes are listed, not only from the active editor.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Export tasks to calendar file")
            .setIcon("calendar-days")
            .onClick(() => void this.exportNoteTasks(file, true))
        );
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const file = info.file;
        if (!file || !isTaskLine(editor.getLine(editor.getCursor().line))) return;
        menu.addItem((item) =>
          item
            .setTitle("Explain calendar event")
            .setIcon("calendar-search")
            .onClick(() => void this.explainEditorLine(editor, file))
        );
      })
    );

    // A calendar view left open overnight must move "today" with the clock.
    this.registerInterval(
      window.setInterval(() => {
        const today = localToday();
        if (today === this.viewDay) return;
        this.viewDay = today;
        this.refreshCalendarViews();
      }, 60_000)
    );

    this.addSettingTab(new TaskCalendarBridgeSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      // Release notes are decided before first-run guidance marks the vault as onboarded: a
      // vault that was never onboarded is a fresh install, and a fresh install has nothing new.
      this.checkForUpdateNotes();
      this.showFirstRunGuidance();
    });
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
    // The calendar view is the onboarding: with no dated tasks it shows the three steps and a
    // button for each. Opened in the sidebar without taking focus from whatever is being read.
    void this.openCalendarView(false);
    new Notice("Task Calendar Bridge is ready. Its calendar is in the right sidebar, with a sample note to start from.", 10000);
  }

  /**
   * Release notes, once per update.
   *
   * Never on a fresh install and never on a downgrade, and the stored version only ever moves
   * forward, so going back a version and returning does not replay notes already read.
   */
  private checkForUpdateNotes(): void {
    if (this.settingsUnreadable) return;
    const current = this.manifest.version;
    const seen = this.settings.lastSeenVersion;
    if (seen && !isNewerVersion(current, seen)) return;

    // Installs from before this setting existed have no stored version. One that was already
    // onboarded is an upgrade, so it gets this release's notes; one that was not is brand new.
    const upgrading = seen ? true : this.settings.hasOnboarded;
    const notes = notesSince(seen || "0", current).filter((release) => release.showOnUpdate !== false);
    this.settings.lastSeenVersion = current;
    void this.saveSettings();

    if (!upgrading || !this.settings.showReleaseNotes) return;
    // From an unknown version, only the newest notes: a long backlog is a wall of text.
    const shown = seen ? notes : notes.slice(0, 1);
    if (shown.length > 0) this.openWhatsNew(shown);
  }

  showWhatsNew(): void {
    const notes = notesSince("0", this.manifest.version);
    if (notes.length === 0) {
      new Notice("No release notes are bundled with this version.");
      return;
    }
    this.openWhatsNew(notes.slice(0, 1));
  }

  private openWhatsNew(notes: ReturnType<typeof notesSince>): void {
    new WhatsNewModal(this.app, notes, {
      showOnUpdate: this.settings.showReleaseNotes,
      setShowOnUpdate: (value) => {
        this.settings.showReleaseNotes = value;
        void this.saveSettings();
      },
      openCalendar: () => void this.openCalendarView(),
    }).open();
  }

  onunload(): void {
    this.unloaded = true;
    // Without this a pending run still fires after the plugin is disabled, writing a calendar —
    // or worse, a settings snapshot — into a vault whose plugin instance is gone.
    this.exportLane.cancel();
    this.saveLane.cancel();
    this.notes.clear();
    this.writer.forget();
  }

  private onVaultChange(path: string, relevant: boolean): void {
    this.notes.forget(path);
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
    this.exportLane.schedule();
    this.refreshCalendarViews();
  }

  // --- Exports ---------------------------------------------------------------

  async exportCurrentNoteTasks(showNotice: boolean): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Open a Markdown note before exporting its tasks.");
      return;
    }
    await this.exportNoteTasks(file, showNotice);
  }

  /** One note's tasks to the current-note file, from the editor, the file list, or the view. */
  async exportNoteTasks(file: TFile, showNotice: boolean): Promise<void> {
    await this.runExport("current note", this.settings.currentNoteOutputPath, showNotice, async () => {
      const result = await this.notes.parse({ path: file.path, mtime: file.stat.mtime }, this.parseOptions());
      return { tasks: [...result.tasks].sort(compareTasks), skipped: result.skipped, totalFound: result.tasks.length, capped: 0 };
    });
  }

  async exportVaultTasks(showNotice: boolean): Promise<void> {
    await this.exportLane.enqueue(() => this.vaultExport(showNotice));
  }

  /**
   * The vault export itself, NOT queued.
   *
   * The lane calls this directly. Going back through `enqueue` from inside a lane task would
   * make that task wait on the chain it is already the head of — a deadlock, and a silent one.
   */
  private vaultExport(showNotice: boolean): Promise<void> {
    return this.runExportNow("whole vault", this.settings.vaultOutputPath, showNotice, async () => {
      const { tasks, skipped } = await this.collectVaultTasks();
      const selected = selectForExport(tasks, this.entitlements(), localToday());
      return { ...selected, skipped };
    });
  }

  /**
   * Every task the whole-vault export reads, before the free cap.
   *
   * One walk for both the export and the calendar view, so the view cannot disagree with the
   * file about which notes count.
   */
  private async collectVaultTasks(): Promise<{ tasks: CalendarTask[]; skipped: SkippedTask[] }> {
    const tasks: CalendarTask[] = [];
    const skipped: SkippedTask[] = [];
    const options = this.parseOptions();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.shouldIncludeFile(file.path)) continue;
      const result = await this.notes.parse({ path: file.path, mtime: file.stat.mtime }, options);
      tasks.push(...result.tasks);
      skipped.push(...result.skipped);
    }
    return { tasks, skipped };
  }

  /** One export at a time, in the order they were asked for. */
  private async runExport(
    scope: string,
    rawPath: string,
    showNotice: boolean,
    collect: () => Promise<{ tasks: CalendarTask[]; skipped: SkippedTask[]; totalFound: number; capped: number }>
  ): Promise<void> {
    await this.exportLane.enqueue(() => this.runExportNow(scope, rawPath, showNotice, collect));
  }

  private async runExportNow(
    scope: string,
    rawPath: string,
    showNotice: boolean,
    collect: () => Promise<{ tasks: CalendarTask[]; skipped: SkippedTask[]; totalFound: number; capped: number }>
  ): Promise<void> {
    if (this.unloaded) return;
    this.exportsRunning++;
    this.refreshCalendarViews();
    try {
      await this.runExportSteps(scope, rawPath, showNotice, collect);
    } finally {
      this.exportsRunning--;
      this.refreshCalendarViews();
    }
  }

  private async runExportSteps(
    scope: string,
    rawPath: string,
    showNotice: boolean,
    collect: () => Promise<{ tasks: CalendarTask[]; skipped: SkippedTask[]; totalFound: number; capped: number }>
  ): Promise<void> {
    const check = precheckExport({
      settingsUnreadable: this.settingsUnreadable,
      dataPath: this.dataPath(),
      rawPath,
      vaultOutputPath: this.settings.vaultOutputPath,
      currentNoteOutputPath: this.settings.currentNoteOutputPath,
    });
    if (!check.ok) {
      // Unreadable settings is not an export failure to record — recording it
      // would mean writing to the very file we just said we cannot trust.
      if (this.settingsUnreadable) new Notice(check.message, 10000);
      else await this.fail(scope, rawPath, check.message);
      return;
    }

    try {
      const collected = await collect();
      const built = buildCalendar({
        tasks: collected.tasks,
        skipped: collected.skipped,
        options: this.calendarOptions(),
        // Read once, here, rather than reached for in the middle of building the file.
        vaultName: this.app.vault.getName(),
        now: new Date(),
      });

      await this.writer.writeToVault(check.path, built.ics, built.signature);

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
          publishedTo = await this.publishCalendarCopy(check.path, built.ics, built.signature);
        } catch (error) {
          publishError = describeError(error);
        }
      }

      if (this.unloaded) return;

      const { report, lastExport } = planReport(built, {
        scope,
        path: check.path,
        totalFound: collected.totalFound,
        capped: collected.capped,
        freeLimit: FREE_TASK_LIMIT,
        now: new Date(),
        publishedTo,
        publishError,
      });
      this.lastReport = report;
      this.settings.lastExport = lastExport;
      this.renderStatusBar();

      if (showNotice) {
        // The formatter reports whether it spent the once-per-session upsell,
        // rather than reaching back into the plugin to set a flag.
        const summary = summariseExport(report, this.capNoticeShown);
        this.capNoticeShown = summary.capNoticeShown;
        new Notice(summary.message, 8000);
      }
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

  /** The index works in paths; Obsidian's cachedRead wants the file object. */
  private mustBeFile(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`${path} is no longer a file in this vault.`);
    return file;
  }

  // --- Settings, delegated to the store ---------------------------------------

  get settings(): TaskCalendarBridgeSettings {
    return this.store.settings;
  }

  /** True when data.json exists but could not be read, so nothing may be saved. */
  get settingsUnreadable(): boolean {
    return this.store.unreadable;
  }

  dataPath(): string {
    return normalizePath(`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/data.json`);
  }

  async saveSettings(): Promise<void> {
    await this.store.save();
    // Most settings change what the calendar view shows: the time mode, the folder filters,
    // a Pro toggle that turns repeats on.
    this.refreshCalendarViews();
  }

  saveSettingsSoon(): void {
    this.store.saveSoon();
    this.refreshCalendarViews();
  }

  flushSettings(): Promise<void> {
    return this.store.flush();
  }

  /** What this licence allows, derived in one place rather than at 22 call sites. */
  private entitlements(): Entitlements {
    return entitlements(this.settings);
  }

  /** The settings that shape the generated file, as the pure builder wants them. */
  private calendarOptions(): CalendarOptions {
    return {
      calendarName: this.settings.calendarName,
      defaultDurationMinutes: this.settings.defaultDurationMinutes,
      timeMode: this.settings.timeMode,
      timeZone: this.settings.timeZone,
      allDayReminderTime: this.settings.allDayReminderTime,
      exportTags: this.settings.exportTags,
      linkToSource: this.settings.linkToSource,
    };
  }

  private parseOptions(): ParseOptions {
    const rights = this.entitlements();
    return {
      includeCompleted: rights.includeCompleted,
      includeRecurrence: rights.includeRecurrence,
      includeReminders: rights.includeReminders,
    };
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
    if (!this.entitlements().publishIsInert) return undefined;
    const target = this.settings.publishPath.trim();
    return `Publishing outside the vault is a Pro feature and is no longer running${target ? `, so the copy in ${target} is out of date` : ""}. Turn off "Publish outside the vault", or reactivate Pro.`;
  }

  /** The settings, expressed as the filter `shouldIncludeNote` understands. */
  private folderFilter(): FolderFilter {
    return {
      includeFolders: this.settings.includeFolders,
      excludeFolders: this.settings.excludeFolders,
      useIncludeFolders: this.entitlements().useIncludeFolders,
      outputPaths: [this.settings.vaultOutputPath, this.settings.currentNoteOutputPath],
    };
  }

  /**
   * Whether the published copy should be written at all, and under what name.
   *
   * Flattened from the whole vault path, not just the basename: two scopes ending in the same
   * file name would otherwise publish over each other.
   */
  private async publishCalendarCopy(vaultPath: string, ics: string, signature: string): Promise<string | undefined> {
    if (this.unloaded) return undefined;
    if (!this.entitlements().publish) return undefined;
    return this.writer.publish({ folder: this.settings.publishPath, fileName: vaultPath.replace(/\//g, "-") }, ics, signature);
  }

  private shouldIncludeFile(path: string): boolean {
    return shouldIncludeNote(path, this.folderFilter());
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

  // --- Calendar view -----------------------------------------------------------

  /**
   * The view's half of the plugin, as a narrow object.
   *
   * The view holds this rather than the plugin, and the plugin never holds the view: Obsidian
   * owns view instances and can recreate them at any time, so a stored reference goes stale.
   */
  private viewHost(): CalendarViewHost {
    // Read through, not captured: the store can replace its settings object.
    const live = (): TaskCalendarBridgeSettings => this.settings;
    return {
      get settings() {
        return live();
      },
      previewSnapshot: () => this.previewSnapshot(),
      exportVaultTasks: (showNotice) => this.exportVaultTasks(showNotice),
      exportActiveNote: () => this.exportCurrentNoteTasks(true),
      showLastReport: () => this.showLastReport(),
      openImportGuide: () => this.openImportGuide(),
      createSampleTaskNote: () => this.createSampleTaskNote(),
      openSettings: () => this.openSettings(),
      saveSettings: () => this.saveSettings(),
      openTask: (item, newLeaf) => this.openTask(item, newLeaf),
      explainTask: (item) => void this.explainItem(item),
      purchaseUrl: PURCHASE_URL,
    };
  }

  async openCalendarView(focus = true): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)[0];
    if (existing) {
      if (focus) await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: CALENDAR_VIEW_TYPE, active: focus });
    if (focus) await this.app.workspace.revealLeaf(leaf);
  }

  refreshCalendarViews(): void {
    if (this.unloaded) return;
    for (const leaf of this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)) {
      // A deferred leaf (a background tab not yet shown) holds a placeholder, not the view.
      if (leaf.view instanceof TaskCalendarView) leaf.view.scheduleRefresh();
    }
  }

  private async computePreview(): Promise<CalendarPreview> {
    const { tasks, skipped } = await this.collectVaultTasks();
    return buildPreview({
      tasks,
      skipped,
      rights: this.entitlements(),
      today: localToday(),
      options: this.calendarOptions(),
      vaultName: this.app.vault.getName(),
      now: new Date(),
    });
  }

  private async previewSnapshot(): Promise<PreviewSnapshot> {
    const preview = await this.computePreview();
    const path = normalizePath(this.settings.vaultOutputPath);
    let contents: string | null = null;
    try {
      if (await this.app.vault.adapter.exists(path)) contents = await this.app.vault.adapter.read(path);
    } catch {
      // Unreadable reads as missing: the next export rewrites it either way.
    }
    return {
      preview,
      file: contents === null ? "missing" : isCalendarCurrent(preview, contents) ? "current" : "stale",
      path,
      today: localToday(),
      busy: this.exportsRunning > 0 || (this.entitlements().autoExport && this.exportLane.isScheduled),
      lastExport: this.settings.lastExport,
    };
  }

  private async openTask(item: PreviewItem, newLeaf: boolean | "tab" | "split" | "window"): Promise<void> {
    const opened = await openTaskSource(this.app, item.task.sourcePath, item.task.line, newLeaf);
    if (!opened) new Notice(`${item.task.sourcePath} is no longer in this vault.`);
  }

  private openSettings(): void {
    // Not in the public API, but stable for years and used widely; feature-detected so a change
    // degrades to a notice rather than an exception.
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    if (!setting) {
      new Notice("Open Settings → Task Calendar Bridge.");
      return;
    }
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  // --- Explain ---------------------------------------------------------------

  private async explainEditorLine(editor: Editor, file: TFile): Promise<void> {
    await this.explainAt(file.path, editor.getValue(), editor.getCursor().line + 1);
  }

  private async explainItem(item: PreviewItem): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(item.task.sourcePath);
    if (!(file instanceof TFile)) return;
    await this.explainAt(file.path, await this.app.vault.cachedRead(file), item.task.line);
  }

  /**
   * Explains one line from text the caller supplies: the editor's live buffer when asked from
   * the editor, so an edit made a second ago is what gets explained, not the last saved copy.
   */
  private async explainAt(path: string, markdown: string, line: number): Promise<void> {
    const inVaultScope = this.shouldIncludeFile(path);
    let preview: CalendarPreview | null = null;
    if (inVaultScope) {
      try {
        preview = await this.computePreview();
      } catch {
        // Without the vault picture the verdict is about this line alone; still worth showing.
      }
    }
    const states = new Map<string, PreviewItem["state"]>();
    for (const item of preview?.items ?? []) states.set(`${item.task.sourcePath}\n${item.task.line}`, item.state);

    const explanation = explainLine({
      markdown,
      sourcePath: path,
      line,
      parseOptions: this.parseOptions(),
      explainOptions: {
        defaultDurationMinutes: this.settings.defaultDurationMinutes,
        allDayReminderTime: this.settings.allDayReminderTime,
        timeMode: this.settings.timeMode,
        timeZone: this.settings.timeZone,
        exportTags: this.settings.exportTags,
      },
      inVaultScope,
      vaultState: preview ? (sourcePath, taskLine) => states.get(`${sourcePath}\n${taskLine}`) : undefined,
      freeLimit: FREE_TASK_LIMIT,
    });
    new ExplainModal(this.app, explanation).open();
  }

  // --- Support -----------------------------------------------------------------

  async copyDiagnostics(): Promise<void> {
    const text = buildDiagnostics({
      pluginVersion: this.manifest.version,
      obsidianVersion: apiVersion,
      platform: Platform.isMobile ? (Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : "mobile") : Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "desktop",
      settings: this.settings,
      publishSupported: isPublishSupported(),
    });
    try {
      await navigator.clipboard.writeText(text);
      new Notice("Diagnostics copied. They hold settings and counts only: no task text, note names, or licence key.");
    } catch {
      new Notice(text, 0);
    }
  }

  private showStatusMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Open task calendar").setIcon("calendar-days").onClick(() => void this.openCalendarView()));
    menu.addItem((item) => item.setTitle("Export the vault calendar").setIcon("refresh-cw").onClick(() => void this.exportVaultTasks(true)));
    menu.addItem((item) => item.setTitle("Show last export report").setIcon("list-checks").onClick(() => this.showLastReport()));
    menu.addItem((item) => item.setTitle("Copy calendar file path").setIcon("copy").onClick(() => void this.copyOutputPath()));
    menu.showAtMouseEvent(event);
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


