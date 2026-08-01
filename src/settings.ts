import { App, PluginSettingTab, Setting } from "obsidian";
import { FREE_TASK_LIMIT, isValidTimeZone, normalizeTime, validateOutputPath, type SkippedTask, type TimeMode } from "./core";
import { LicenseManager } from "./license/LicenseManager";
import type TaskCalendarBridgePlugin from "./main";

export interface LastExport {
  at: string;
  scope: string;
  path: string;
  eventCount: number;
  skippedCount: number;
  error?: string;
  publishError?: string;
  /** Kept so the report survives a restart, when it is needed most. */
  skipped?: SkippedTask[];
  totalFound?: number;
  capped?: number;
}

export interface TaskCalendarBridgeSettings {
  licenseKey: string;
  isPro: boolean;
  licenseEmail: string;
  purchaseUrl: string;
  calendarName: string;
  vaultOutputPath: string;
  currentNoteOutputPath: string;
  defaultDurationMinutes: number;
  timeMode: TimeMode;
  timeZone: string;
  allDayReminderTime: string;
  exportTags: boolean;
  autoExport: boolean;
  includeCompleted: boolean;
  includeReminders: boolean;
  includeRecurrence: boolean;
  includeFolders: string;
  excludeFolders: string;
  publishEnabled: boolean;
  publishPath: string;
  lastExport: LastExport | null;
  /** Paths this plugin created, so it never overwrites a file it does not own. */
  ownedPaths: string[];
  hasOnboarded: boolean;
}

export const DEFAULT_SETTINGS: TaskCalendarBridgeSettings = {
  licenseKey: "",
  isPro: false,
  licenseEmail: "",
  purchaseUrl: "https://buymeacoffee.com/vaultspotlight/e/560210",
  calendarName: "Obsidian Tasks",
  vaultOutputPath: "Calendar/tasks.ics",
  currentNoteOutputPath: "Calendar/current-note.ics",
  defaultDurationMinutes: 30,
  timeMode: "floating",
  timeZone: "",
  allDayReminderTime: "09:00",
  exportTags: true,
  autoExport: false,
  includeCompleted: false,
  // Sold as "Pro adds repeating events and reminders", so they are on the
  // moment Pro is active. Both are gated by isPro at export time anyway, and
  // shipping them off by default made a paid feature look broken.
  includeReminders: true,
  includeRecurrence: true,
  includeFolders: "",
  excludeFolders: "",
  publishEnabled: false,
  publishPath: "",
  lastExport: null,
  ownedPaths: [],
  hasOnboarded: false,
};

type ProToggleKey = "autoExport" | "includeCompleted" | "includeReminders" | "includeRecurrence" | "publishEnabled";
type ProTextKey = "includeFolders" | "excludeFolders" | "publishPath";

export class TaskCalendarBridgeSettingTab extends PluginSettingTab {
  plugin: TaskCalendarBridgePlugin;
  private licenseDraft = "";
  private licenseMessage = "";

  constructor(app: App, plugin: TaskCalendarBridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.licenseDraft = this.plugin.settings.licenseKey;

    this.renderLicense(containerEl);
    this.renderExport(containerEl);
    this.renderTime(containerEl);
    this.renderPro(containerEl);
    this.renderHelp(containerEl);
  }

  hide(): void {
    // A stale "that key could not be verified" reappearing days later, on a tab
    // the user opened for something else, reads like a fresh failure.
    this.licenseMessage = "";
  }

  // --- License ---------------------------------------------------------------

  private renderLicense(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("License").setHeading();

    // Verification runs on Activate, on Enter, and on blur — never on every
    // keystroke, which used to rebuild this whole tab and steal the caret.
    new Setting(containerEl)
      .setName("License key")
      .setDesc("Verified offline — no account or server. Paste your key and choose Activate.")
      .addText((text) => {
        text
          .setPlaceholder("payload.signature")
          .setValue(this.plugin.settings.licenseKey)
          .onChange((value) => {
            this.licenseDraft = value;
          });
        text.inputEl.addEventListener("blur", () => void this.activate());
        text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key === "Enter") void this.activate();
        });
      })
      .addButton((button) => button.setButtonText("Activate").setCta().onClick(() => void this.activate()));

    const status = containerEl.createDiv({ cls: "task-calendar-bridge-status" });
    if (this.plugin.settings.isPro) {
      const email = this.plugin.settings.licenseEmail;
      status.createEl("p", { text: `Pro active${email ? ` (${email})` : ""}. Thank you.` });
      new Setting(containerEl)
        .setName("Remove license")
        .setDesc("Deactivates Pro on this device. Keep a copy of your key first — it is not stored anywhere else.")
        .addButton((button) =>
          button.setButtonText("Remove").setWarning().onClick(() => {
            void (async () => {
              this.plugin.settings.licenseKey = "";
              this.licenseMessage = "";
              await this.plugin.refreshLicense();
              this.display();
            })();
          })
        );
    } else {
      status.createEl("p", {
        text: `Free: unlimited current-note export, plus the next ${FREE_TASK_LIMIT} upcoming tasks from the whole vault.`,
      });
      const link = status.createEl("a", { text: "Get Pro", href: this.plugin.settings.purchaseUrl });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
    }
    if (this.licenseMessage) {
      status.createEl("p", { text: this.licenseMessage, cls: "task-calendar-bridge-error" });
    }
  }

  private async activate(): Promise<void> {
    const key = this.licenseDraft.trim();
    // Blur fires on any focus change, including clicking another setting, so an
    // unchanged field must do nothing at all — not re-render and steal focus.
    if (key === this.plugin.settings.licenseKey) return;

    if (!key) {
      // Emptying the field and clicking away used to wipe the stored key —
      // the same irreversible loss the verify-before-store change fixed.
      // Removing a license is now a deliberate act.
      if (this.plugin.settings.licenseKey) {
        this.licenseDraft = this.plugin.settings.licenseKey;
        this.licenseMessage = 'Your license is unchanged. Use "Remove license" if you really want to deactivate Pro here.';
        this.display();
      }
      return;
    }

    // Verify before storing. Storing first meant one mistyped or line-wrapped
    // paste overwrote a working key, and the only copy of it was gone.
    const result = LicenseManager.verify(key);
    if (!result.valid) {
      this.licenseMessage = `${result.error ?? "That key could not be verified."} Your existing license is unchanged.`;
      this.display();
      return;
    }

    this.plugin.settings.licenseKey = key;
    this.licenseMessage = "";
    await this.plugin.refreshLicense();
    this.display();
  }

  // --- Export ----------------------------------------------------------------

  private renderExport(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Export").setHeading();

    new Setting(containerEl)
      .setName("Calendar name")
      .setDesc("The calendar title embedded in the generated file.")
      .addText((text) =>
        text.setValue(this.plugin.settings.calendarName).onChange((value) => {
          this.plugin.settings.calendarName = value.trim() || DEFAULT_SETTINGS.calendarName;
          void this.plugin.saveSettings();
        })
      );

    this.pathSetting(
      containerEl,
      "Full-vault output path",
      "Where the whole-vault calendar is written. Must end in .ics.",
      "vaultOutputPath"
    );
    this.pathSetting(
      containerEl,
      "Current-note output path",
      "A separate file, so exporting one note never overwrites the vault calendar.",
      "currentNoteOutputPath"
    );

    new Setting(containerEl)
      .setName("Default timed-task duration")
      .setDesc("Minutes used when a task has a start time but no duration.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.defaultDurationMinutes)).onChange((value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.defaultDurationMinutes =
            Number.isFinite(parsed) && parsed > 0 && parsed <= 1440 ? parsed : DEFAULT_SETTINGS.defaultDurationMinutes;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Export tags as categories")
      .setDesc("Turn #tags on a task into calendar categories you can colour and filter by.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.exportTags).onChange((value) => {
          this.plugin.settings.exportTags = value;
          void this.plugin.saveSettings();
        })
      );

    const last = this.plugin.settings.lastExport;
    const info = containerEl.createDiv({ cls: "task-calendar-bridge-status" });
    if (!last) {
      info.createEl("p", { text: "Nothing exported yet. Run “Export vault tasks to ICS” from the command palette." });
    } else if (last.error) {
      info.createEl("p", { text: `Last export failed: ${last.error}`, cls: "task-calendar-bridge-error" });
    } else {
      info.createEl("p", {
        text: `Last export: ${last.eventCount} event${last.eventCount === 1 ? "" : "s"} to ${last.path} (${last.scope}), ${last.skippedCount} task${last.skippedCount === 1 ? "" : "s"} skipped.`,
      });
      // A publish that fails on every silent auto-export leaves subscribers on a
      // stale calendar; without this the only signal was a one-off notice.
      if (last.publishError) {
        info.createEl("p", { text: `Publishing outside the vault failed: ${last.publishError}`, cls: "task-calendar-bridge-error" });
      }
    }
  }

  private pathSetting(containerEl: HTMLElement, name: string, desc: string, key: "vaultOutputPath" | "currentNoteOutputPath"): void {
    let errorEl: HTMLElement | null = null;
    const setting = new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text.setValue(this.plugin.settings[key]).onChange((value) => {
          const check = validateOutputPath(value);
          errorEl?.remove();
          errorEl = null;
          const showError = (message: string): void => {
            errorEl = setting.descEl.createEl("p", { text: message, cls: "task-calendar-bridge-error" });
          };
          if (!check.ok) {
            showError(check.error ?? "Invalid path.");
            return;
          }
          // Pointing both scopes at one file recreates the 1.0.x defect where a
          // current-note export silently replaced the whole-vault calendar.
          const other = key === "vaultOutputPath" ? this.plugin.settings.currentNoteOutputPath : this.plugin.settings.vaultOutputPath;
          if (check.path === other) {
            showError("The two output paths must be different files.");
            return;
          }
          this.plugin.settings[key] = check.path;
          void this.plugin.saveSettings();
        })
      );
  }

  // --- Time ------------------------------------------------------------------

  private renderTime(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Time handling").setHeading();

    new Setting(containerEl)
      .setName("Timed events")
      .setDesc(
        "Local wall time keeps 14:15 showing as 14:15 on every device. Fixed time zone pins each event to a real instant, so it stays correct when you travel."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("floating", "Local wall time")
          .addOption("zoned", "Fixed time zone")
          .setValue(this.plugin.settings.timeMode)
          .onChange((value) => {
            this.plugin.settings.timeMode = value === "zoned" ? "zoned" : "floating";
            if (this.plugin.settings.timeMode === "zoned" && !this.plugin.settings.timeZone) {
              this.plugin.settings.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
            }
            void this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.timeMode === "zoned") {
      let zoneError: HTMLElement | null = null;
      const setting = new Setting(containerEl)
        .setName("Time zone")
        .setDesc("An IANA name such as Europe/Madrid or America/New_York.")
        .addText((text) =>
          text
            .setPlaceholder(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC")
            .setValue(this.plugin.settings.timeZone)
            .onChange((value) => {
              zoneError?.remove();
              zoneError = null;
              const zone = value.trim();
              if (!isValidTimeZone(zone)) {
                zoneError = setting.descEl.createEl("p", {
                  text: "Not a time zone this device recognises.",
                  cls: "task-calendar-bridge-error",
                });
                return;
              }
              this.plugin.settings.timeZone = zone;
              void this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("All-day reminder time")
      .setDesc("When an alarm on an all-day task fires. Without this, alarms land at 23:30 the night before.")
      .addText((text) =>
        text.setPlaceholder("09:00").setValue(this.plugin.settings.allDayReminderTime).onChange((value) => {
          const normalized = normalizeTime(value);
          if (!normalized) return;
          this.plugin.settings.allDayReminderTime = normalized;
          void this.plugin.saveSettings();
        })
      );
  }

  // --- Pro -------------------------------------------------------------------

  private renderPro(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Pro automation").setHeading();

    this.proToggle(containerEl, "Full-vault export without the cap", `Free exports the next ${FREE_TASK_LIMIT} upcoming tasks; Pro exports every dated task.`, null);
    this.proToggle(containerEl, "Auto-export on note changes", "Regenerate the vault calendar whenever a note changes.", "autoExport");
    this.proToggle(containerEl, "Repeating tasks", "Turn a 🔁 repeat rule into a real recurring calendar event.", "includeRecurrence");
    this.proToggle(containerEl, "Reminder alarms", "Use reminder values as calendar alarms.", "includeReminders");
    this.proToggle(containerEl, "Include completed tasks", "Export finished tasks so your calendar shows what you actually did.", "includeCompleted");

    this.proText(containerEl, "Include folders", "Comma-separated folders. Blank means the whole vault.", "includeFolders", "Projects, Work");
    this.proText(containerEl, "Exclude folders", "Comma-separated folders to skip.", "excludeFolders", "Archive, Templates");

    new Setting(containerEl).setName("Live calendar publishing").setHeading();
    this.proToggle(
      containerEl,
      "Publish outside the vault",
      "Also write the calendar to a folder your cloud drive syncs, so your calendar app can subscribe to it instead of you re-importing by hand. Desktop only.",
      "publishEnabled"
    );
    this.proText(
      containerEl,
      "Publish folder",
      "An absolute folder path, for example a Dropbox or iCloud Drive folder.",
      "publishPath",
      "/Users/you/Dropbox/calendar"
    );

    if (this.plugin.settings.isPro && this.plugin.settings.publishEnabled && !this.plugin.settings.publishPath.trim()) {
      containerEl.createEl("p", {
        text: "Publishing is on but no folder is set, so nothing is being published.",
        cls: "task-calendar-bridge-error",
      });
    }
  }

  private proToggle(containerEl: HTMLElement, name: string, desc: string, key: ProToggleKey | null): void {
    const setting = new Setting(containerEl).setName(name).setDesc(desc);
    if (!this.plugin.settings.isPro) {
      this.lock(setting);
      return;
    }
    if (!key) {
      setting.addExtraButton((button) => button.setIcon("check").setTooltip("Included in Pro").setDisabled(true));
      return;
    }
    setting.addToggle((toggle) =>
      toggle.setValue(Boolean(this.plugin.settings[key])).onChange((value) => {
        this.plugin.settings[key] = value;
        void this.plugin.saveSettings();
      })
    );
  }

  private proText(containerEl: HTMLElement, name: string, desc: string, key: ProTextKey, placeholder: string): void {
    const setting = new Setting(containerEl).setName(name).setDesc(desc);
    if (!this.plugin.settings.isPro) {
      this.lock(setting);
      return;
    }
    setting.addText((text) =>
      text.setPlaceholder(placeholder).setValue(this.plugin.settings[key]).onChange((value) => {
        this.plugin.settings[key] = value.trim();
        void this.plugin.saveSettings();
      })
    );
  }

  /** A locked row is a sales surface, not a dead row: give it a way to buy. */
  private lock(setting: Setting): void {
    setting.settingEl.addClass("task-calendar-bridge-locked");
    setting.addButton((button) =>
      button
        .setButtonText("Get Pro")
        .setTooltip("Unlock with a one-time license")
        .onClick(() => window.open(this.plugin.settings.purchaseUrl, "_blank"))
    );
  }

  // --- Help ------------------------------------------------------------------

  private renderHelp(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Help").setHeading();

    new Setting(containerEl)
      .setName("Calendar setup guide")
      .setDesc("How to import or subscribe in Google Calendar, Apple Calendar, Outlook, and TickTick.")
      .addButton((button) => button.setButtonText("Open guide").onClick(() => this.plugin.openImportGuide()));

    new Setting(containerEl)
      .setName("Sample task note")
      .setDesc("Create a note showing every supported task syntax.")
      .addButton((button) => button.setButtonText("Create sample").onClick(() => void this.plugin.createSampleTaskNote()));

    new Setting(containerEl)
      .setName("Last export report")
      .setDesc("See what was exported and why anything was skipped.")
      .addButton((button) => button.setButtonText("Show report").onClick(() => this.plugin.showLastReport()));
  }
}
