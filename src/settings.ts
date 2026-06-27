import { App, PluginSettingTab, Setting } from "obsidian";
import type TaskCalendarBridgePlugin from "./main";

export interface TaskCalendarBridgeSettings {
  licenseKey: string;
  isPro: boolean;
  licenseEmail: string;
  purchaseUrl: string;
  calendarName: string;
  outputPath: string;
  includeCompleted: boolean;
  autoExport: boolean;
  includeReminders: boolean;
  defaultDurationMinutes: number;
  maxFreeTasks: number;
  includeFolders: string;
  excludeFolders: string;
}

export const DEFAULT_SETTINGS: TaskCalendarBridgeSettings = {
  licenseKey: "",
  isPro: false,
  licenseEmail: "",
  purchaseUrl: "https://buymeacoffee.com/taskcalendarbridge",
  calendarName: "Obsidian Tasks",
  outputPath: ".task-calendar-bridge/tasks.ics",
  includeCompleted: false,
  autoExport: false,
  includeReminders: false,
  defaultDurationMinutes: 30,
  maxFreeTasks: 25,
  includeFolders: "",
  excludeFolders: "",
};

export class TaskCalendarBridgeSettingTab extends PluginSettingTab {
  plugin: TaskCalendarBridgePlugin;

  constructor(app: App, plugin: TaskCalendarBridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Settings" });

    new Setting(containerEl)
      .setName("License key")
      .setDesc("Enter your Pro license key. Verified offline — no account or server required.")
      .addText((text) =>
        text
          .setPlaceholder("payload.signature")
          .setValue(this.plugin.settings.licenseKey)
          .onChange((value) => {
            this.plugin.settings.licenseKey = value;
            void this.plugin.refreshLicense().then(() => this.display());
          })
      );

    const status = containerEl.createDiv({ cls: "task-calendar-bridge-status" });
    if (this.plugin.settings.isPro) {
      status.createEl("p", { text: `Pro active${this.plugin.settings.licenseEmail ? ` (${this.plugin.settings.licenseEmail})` : ""}.` });
    } else {
      status.createEl("p", { text: `Free tier active. Current-note export is unlimited; full-vault export is capped at ${this.plugin.settings.maxFreeTasks} tasks.` });
      const link = status.createEl("a", { text: "Get Pro", href: this.plugin.settings.purchaseUrl });
      link.setAttr("target", "_blank");
    }

    new Setting(containerEl)
      .setName("Purchase page URL")
      .setDesc("Link shown for Pro upgrades.")
      .addText((text) =>
        text.setPlaceholder("https://your-store.com/product").setValue(this.plugin.settings.purchaseUrl).onChange((value) => {
          this.plugin.settings.purchaseUrl = value.trim() || DEFAULT_SETTINGS.purchaseUrl;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Calendar name")
      .setDesc("The calendar title embedded in the generated ICS file.")
      .addText((text) =>
        text.setValue(this.plugin.settings.calendarName).onChange((value) => {
          this.plugin.settings.calendarName = value.trim() || DEFAULT_SETTINGS.calendarName;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Output path")
      .setDesc("Vault-relative path for the generated ICS file.")
      .addText((text) =>
        text.setPlaceholder(".task-calendar-bridge/tasks.ics").setValue(this.plugin.settings.outputPath).onChange((value) => {
          this.plugin.settings.outputPath = value.trim() || DEFAULT_SETTINGS.outputPath;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Default timed-task duration")
      .setDesc("Used when a task has [start:: HH:mm] but no [duration:: 45m].")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.defaultDurationMinutes)).onChange((value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.defaultDurationMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.defaultDurationMinutes;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Import guide")
      .setDesc("Open setup instructions for Google Calendar, Apple Calendar, Outlook, and TickTick.")
      .addButton((button) => button.setButtonText("Open guide").onClick(() => this.plugin.openImportGuide()));

    new Setting(containerEl)
      .setName("Sample task note")
      .setDesc("Create a note with every supported task syntax.")
      .addButton((button) => button.setButtonText("Create sample").onClick(() => void this.plugin.createSampleTaskNote()));

    new Setting(containerEl).setName("Pro automation").setHeading();

    this.proToggle("Auto-export on note changes", "Regenerate the full-vault ICS whenever Markdown files change.", "autoExport");
    this.proToggle("Include completed tasks", "Export checked tasks as completed calendar events.", "includeCompleted");
    this.proToggle("Include reminder alarms", "Use [reminder:: 30m] values as calendar alarms.", "includeReminders");

    this.proText("Include folders", "Comma-separated folder prefixes. Blank means whole vault.", "includeFolders", "Projects, Work");
    this.proText("Exclude folders", "Comma-separated folder prefixes to skip.", "excludeFolders", "Archive, Templates");
  }

  private proToggle(name: string, desc: string, key: "autoExport" | "includeCompleted" | "includeReminders"): void {
    const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
    if (!this.plugin.settings.isPro) {
      setting.settingEl.addClass("task-calendar-bridge-locked");
      return;
    }
    setting.addToggle((toggle) =>
      toggle.setValue(Boolean(this.plugin.settings[key])).onChange((value) => {
        this.plugin.settings[key] = value;
        void this.plugin.saveSettings();
      })
    );
  }

  private proText(name: string, desc: string, key: "includeFolders" | "excludeFolders", placeholder: string): void {
    const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
    if (!this.plugin.settings.isPro) {
      setting.settingEl.addClass("task-calendar-bridge-locked");
      return;
    }
    setting.addText((text) =>
      text.setPlaceholder(placeholder).setValue(this.plugin.settings[key]).onChange((value) => {
        this.plugin.settings[key] = value;
        void this.plugin.saveSettings();
      })
    );
  }
}
