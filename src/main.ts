import { debounce, Notice, Plugin, TFile } from "obsidian";
import { generateIcsCalendar, parseTasksFromMarkdown, filterTasksForTier, type CalendarTask } from "./core";
import { SAMPLE_TASK_NOTE } from "./core/help";
import { HelpModal } from "./HelpModal";
import { LicenseManager } from "./license/LicenseManager";
import { DEFAULT_SETTINGS, TaskCalendarBridgeSettingTab, type TaskCalendarBridgeSettings } from "./settings";

export default class TaskCalendarBridgePlugin extends Plugin {
  settings: TaskCalendarBridgeSettings = DEFAULT_SETTINGS;
  private autoExportDebounced!: () => void;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.refreshLicense();

    this.autoExportDebounced = debounce(() => {
      if (this.settings.isPro && this.settings.autoExport) void this.exportVaultTasks(false);
    }, 2000, true);

    this.addRibbonIcon("calendar-days", "Export Obsidian tasks to ICS", () => void this.exportCurrentNoteTasks(true));

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
      name: "Copy ICS vault path",
      callback: () => void this.copyOutputPath(),
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

    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.extension === "md") this.autoExportDebounced();
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile && file.extension === "md") this.autoExportDebounced();
    }));
    this.registerEvent(this.app.vault.on("delete", () => this.autoExportDebounced()));

    this.addSettingTab(new TaskCalendarBridgeSettingTab(this.app, this));
  }

  onunload(): void {}

  async exportCurrentNoteTasks(showNotice: boolean): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Open a Markdown note before exporting current-note tasks.");
      return;
    }

    const markdown = await this.app.vault.read(file);
    const tasks = parseTasksFromMarkdown(markdown, file.path, { includeCompleted: this.settings.isPro && this.settings.includeCompleted });
    await this.writeIcs(tasks);
    if (showNotice) new Notice(`Exported ${tasks.length} task${tasks.length === 1 ? "" : "s"} to ${this.settings.outputPath}.`);
  }

  async exportVaultTasks(showNotice: boolean): Promise<void> {
    const allTasks: CalendarTask[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.shouldIncludeFile(file.path)) continue;
      const markdown = await this.app.vault.cachedRead(file);
      allTasks.push(...parseTasksFromMarkdown(markdown, file.path, { includeCompleted: this.settings.isPro && this.settings.includeCompleted }));
    }

    const exported = filterTasksForTier(allTasks, { isPro: this.settings.isPro, maxFreeTasks: this.settings.maxFreeTasks });
    await this.writeIcs(exported);

    if (showNotice) {
      const cap = !this.settings.isPro && allTasks.length > exported.length ? ` Free tier exported first ${exported.length}; upgrade for all ${allTasks.length}.` : "";
      new Notice(`Exported ${exported.length} vault task${exported.length === 1 ? "" : "s"} to ${this.settings.outputPath}.${cap}`);
    }
  }

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
    const loaded = data !== null && typeof data === "object" ? (data as Partial<TaskCalendarBridgeSettings>) : {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async writeIcs(tasks: CalendarTask[]): Promise<void> {
    const ics = generateIcsCalendar(tasks, {
      calendarName: this.settings.calendarName,
      productId: "-//Task Calendar Bridge//EN",
      includeReminders: this.settings.isPro && this.settings.includeReminders,
      defaultDurationMinutes: this.settings.defaultDurationMinutes,
    });

    await this.ensureParentFolder(this.settings.outputPath);
    if (await this.app.vault.adapter.exists(this.settings.outputPath)) {
      await this.app.vault.adapter.write(this.settings.outputPath, ics);
    } else {
      await this.app.vault.create(this.settings.outputPath, ics);
    }
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    if (parts.length === 0) return;

    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private shouldIncludeFile(path: string): boolean {
    const includes = splitCsv(this.settings.includeFolders);
    const excludes = splitCsv(this.settings.excludeFolders);
    if (this.settings.isPro && includes.length > 0 && !includes.some((folder) => path.startsWith(folder))) return false;
    if (this.settings.isPro && excludes.some((folder) => path.startsWith(folder))) return false;
    return true;
  }

  private async copyOutputPath(): Promise<void> {
    const path = this.settings.outputPath;
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

function splitCsv(value: string): string[] {
  return value.split(",").map((part) => part.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean);
}
