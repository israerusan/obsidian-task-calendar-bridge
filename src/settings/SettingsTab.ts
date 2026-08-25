import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import {
  describeAge,
  FREE_TASK_LIMIT,
  isSameFile,
  isValidTimeZone,
  normalizeTime,
  validateOutputPath,
} from "../core";
import { LicenseManager } from "../license/LicenseManager";
import { isAbsolutePath, isPublishSupported } from "../publish";
import {
  DEFAULT_SETTINGS,
  PURCHASE_URL,
  type PluginHost,
  type ProTextKey,
  type ProToggleKey,
} from "./schema";

// The schema, the persisted record and the purchase URL live in ./schema. This file only
// draws the tab, and is typed against PluginHost rather than the plugin class — which is
// what stops the settings layer importing main.ts and closes the last import cycle.


/**
 * An inline error a user can actually perceive.
 *
 * Colour alone says nothing to a screen reader and is ambiguous with ordinary
 * description text for a colour-blind user, so the message is announced and
 * labelled in the text as well as coloured.
 */
function showFieldError(host: HTMLElement, message: string): HTMLElement {
  const el = host.createEl("p", { text: `Error: ${message}`, cls: "task-calendar-bridge-error" });
  el.setAttr("role", "alert");
  return el;
}

export class TaskCalendarBridgeSettingTab extends PluginSettingTab {
  plugin: PluginHost;
  private licenseDraft = "";
  private licenseMessage = "";
  /**
   * A key that failed verification, kept on screen so it can be repaired.
   * Re-rendering the tab used to reset the field to the *stored* key — empty
   * for a first-time buyer — so the key someone had just pasted vanished under
   * an error telling them to try again, and Activate then did nothing at all.
   */
  private licenseRejected = "";
  /** Blur-committed fields, so closing the tab commits them too. */
  private pendingCommits: Array<() => void> = [];

  constructor(app: App, plugin: Plugin & PluginHost) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.pendingCommits = [];
    this.licenseDraft = this.licenseRejected || this.plugin.settings.licenseKey;

    this.renderLoadFailure(containerEl);
    this.renderLicense(containerEl);
    this.renderExport(containerEl);
    this.renderTime(containerEl);
    this.renderPro(containerEl);
    this.renderHelp(containerEl);
    this.renderFeedback(containerEl);
  }

  hide(): void {
    // A stale "that key could not be verified" reappearing days later, on a tab
    // the user opened for something else, reads like a fresh failure.
    this.licenseMessage = "";
    this.licenseRejected = "";
    // Commit anything still sitting in a focused field, then flush. Closing the
    // settings modal detaches the input without a reliable blur, which is exactly
    // how someone finishes typing in one.
    for (const commit of this.pendingCommits) commit();
    this.pendingCommits = [];
    void this.plugin.flushSettings();
  }

  /**
   * Nothing in this tab can be saved while data.json is unreadable, so say so
   * before the user spends ten minutes configuring settings that will not stick.
   */
  private renderLoadFailure(containerEl: HTMLElement): void {
    if (!this.plugin.settingsUnreadable) return;
    const banner = containerEl.createDiv({ cls: "task-calendar-bridge-status" });
    showFieldError(
      banner,
      `Task Calendar Bridge could not read its settings file, so nothing here will be saved. Your license key and settings are still in ${this.plugin.dataPath()} — restore or fix that file and restart Obsidian.`
    );
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
          .setValue(this.licenseDraft)
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
      const link = status.createEl("a", { text: "Get Pro", href: PURCHASE_URL });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
    }
    if (this.licenseMessage) {
      showFieldError(status, this.licenseMessage);
    }
  }

  private async activate(): Promise<void> {
    const key = this.licenseDraft.trim();
    // Blur fires on any focus change, including clicking another setting, so an
    // unchanged field must do nothing at all — not re-render and steal focus.
    if (key === this.plugin.settings.licenseKey && !this.licenseRejected) return;

    if (!key) {
      // Emptying the field and clicking away used to wipe the stored key —
      // the same irreversible loss the verify-before-store change fixed.
      // Removing a license is now a deliberate act.
      this.licenseRejected = "";
      this.licenseMessage = this.plugin.settings.licenseKey
        ? 'Your license is unchanged. Use "Remove license" if you really want to deactivate Pro here.'
        : "Paste your license key first, then choose Activate.";
      this.display();
      return;
    }

    // Verify before storing. Storing first meant one mistyped or line-wrapped
    // paste overwrote a working key, and the only copy of it was gone.
    const result = LicenseManager.verify(key);
    if (!result.valid) {
      this.licenseRejected = this.licenseDraft;
      this.licenseMessage = `${result.error ?? "That key could not be verified."} Your existing license is unchanged — the key you pasted is still in the field above, so you can check it for a missing character or a line break.`;
      this.display();
      return;
    }

    const wasPro = this.plugin.settings.isPro;
    this.plugin.settings.licenseKey = key;
    this.licenseRejected = "";
    this.licenseMessage = "";
    await this.plugin.refreshLicense();
    this.display();

    // The two features Pro is sold on — auto-export and publishing — default to
    // off and stayed off after purchase, with nothing on screen saying so. A
    // buyer edited notes for a week and found a stale calendar.
    if (!wasPro && this.plugin.settings.isPro && !this.plugin.settings.autoExport) {
      new Notice(
        "Pro is active. Two things are still off by default: turn on “Auto-export on note changes” to keep the calendar current, and set a publish folder if you want your calendar app to subscribe instead of re-importing.",
        12000
      );
    }
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
          this.plugin.saveSettingsSoon();
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

    // Validated rather than coerced. `parseInt("1h")` is 1, so a plausible typo
    // silently turned every timed task into a one-minute event; and `2000` was
    // silently replaced by 30 while the field still read 2000, so the tab
    // displayed one value and the exporter used another.
    this.validatedText(containerEl, {
      name: "Default timed-task duration",
      desc: "Minutes used when a task has a start time but no duration. Between 1 and 1440.",
      value: String(this.plugin.settings.defaultDurationMinutes),
      parse: (raw) => {
        const trimmed = raw.trim();
        if (!/^\d+$/.test(trimmed)) return { error: "Enter a whole number of minutes, for example 30." };
        const parsed = Number.parseInt(trimmed, 10);
        if (parsed < 1 || parsed > 1440) return { error: "Enter between 1 and 1440 minutes (24 hours)." };
        return { value: String(parsed) };
      },
      apply: (value) => {
        this.plugin.settings.defaultDurationMinutes = Number(value);
      },
    });

    new Setting(containerEl)
      .setName("Export tags as categories")
      .setDesc("Turn #tags on a task into calendar categories you can colour and filter by.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.exportTags).onChange((value) => {
          this.plugin.settings.exportTags = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Link events back to their note")
      .setDesc(
        "Each event names the note and line it came from and carries a link that opens it. Turn this off to keep your vault's name and folder structure out of the file — worth doing if you publish the calendar to a URL."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.linkToSource).onChange((value) => {
          this.plugin.settings.linkToSource = value;
          void this.plugin.saveSettings();
        })
      );

    const last = this.plugin.settings.lastExport;
    const info = containerEl.createDiv({ cls: "task-calendar-bridge-status" });
    if (!last) {
      info.createEl("p", { text: "Nothing exported yet. Run “Export vault tasks to ICS” from the command palette." });
    } else if (last.error) {
      showFieldError(info, `Last export failed: ${last.error}`);
    } else {
      // Only genuine losses are counted here. Counting every completed checkbox
      // in the vault as "skipped" made a healthy export read as a broken one:
      // 400 done tasks became "400 tasks skipped".
      const lost = last.counts?.lost ?? last.skippedCount;
      const age = describeAge(last.at);
      info.createEl("p", {
        text:
          `Last export${age ? ` ${age}` : ""}: ${last.eventCount} event${last.eventCount === 1 ? "" : "s"} to ${last.path} (${last.scope})` +
          (lost > 0 ? `, ${lost} task${lost === 1 ? "" : "s"} could not be exported.` : "."),
      });
      // A publish that fails on every silent auto-export leaves subscribers on a
      // stale calendar; without this the only signal was a one-off notice.
      if (last.publishError) {
        showFieldError(info, `Publishing outside the vault failed: ${last.publishError}`);
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
          // Compared the way the export does — case-insensitively, as Windows
          // and macOS do — because a case-only difference used to pass here and
          // then abort every single export with no warning at the point of entry.
          const other = key === "vaultOutputPath" ? this.plugin.settings.currentNoteOutputPath : this.plugin.settings.vaultOutputPath;
          if (isSameFile(check.path, other)) {
            showError("The two output paths must be different files. On Windows and macOS that includes differing only in capitalisation.");
            return;
          }
          this.plugin.settings[key] = check.path;
          this.plugin.saveSettingsSoon();
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
              this.plugin.saveSettingsSoon();
            })
        );
    }

    this.validatedText(containerEl, {
      name: "All-day reminder time",
      desc: "When an alarm on an all-day task fires. Without this, alarms land at 23:30 the night before.",
      value: this.plugin.settings.allDayReminderTime,
      placeholder: "09:00",
      parse: (raw) => {
        const normalized = normalizeTime(raw);
        // An unreadable value used to be swallowed with no message at all, so
        // the field showed one time and the alarms fired at another.
        if (!normalized) return { error: "Use a time like 09:00 or 7:30 pm." };
        return { value: normalized };
      },
      apply: (value) => {
        this.plugin.settings.allDayReminderTime = value;
      },
    });
  }

  /**
   * A text setting that reports what it rejected and writes back what it
   * accepted, so the value on screen is always the value in use.
   *
   * Validation runs on blur, not on every keystroke: mid-typing, "3" on the way
   * to "30" is not an error worth shouting about.
   */
  private validatedText(
    containerEl: HTMLElement,
    options: {
      name: string;
      desc: string;
      value: string;
      placeholder?: string;
      parse: (raw: string) => { value: string } | { error: string };
      apply: (value: string) => void;
    }
  ): void {
    let errorEl: HTMLElement | null = null;
    const setting = new Setting(containerEl)
      .setName(options.name)
      .setDesc(options.desc)
      .addText((text) => {
        if (options.placeholder) text.setPlaceholder(options.placeholder);
        text.setValue(options.value);
        const commit = (): void => {
          errorEl?.remove();
          errorEl = null;
          const result = options.parse(text.getValue());
          if ("error" in result) {
            errorEl = showFieldError(setting.descEl, result.error);
            return;
          }
          text.setValue(result.value);
          options.apply(result.value);
          void this.plugin.saveSettings();
        };
        text.inputEl.addEventListener("blur", commit);
        text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key === "Enter") commit();
        });
        // Also on close. Closing the settings modal detaches the input without a
        // reliable blur, which is exactly how someone finishes typing in a field.
        this.pendingCommits.push(commit);
      });
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

    // Writing outside the vault needs Node's fs, which mobile does not have.
    // Offering a working-looking toggle there meant the only way to find out was
    // an export failing with "publishing only works on desktop".
    if (!isPublishSupported()) {
      new Setting(containerEl)
        .setName("Publish outside the vault")
        .setDesc("Available on desktop only — this device cannot write outside the vault.")
        .setDisabled(true);
      return;
    }

    this.proToggle(
      containerEl,
      "Publish outside the vault",
      "Also write the calendar to a folder your cloud drive syncs, so your calendar app can subscribe to it instead of you re-importing by hand.",
      "publishEnabled"
    );
    this.proText(
      containerEl,
      "Publish folder",
      "An absolute folder path, for example a Dropbox or OneDrive folder.",
      "publishPath",
      "/Users/you/Dropbox/calendar",
      (raw) => {
        const value = raw.trim();
        if (!value) return undefined;
        // The same rule the writer applies, checked as it is typed rather than
        // at the next export — which, with auto-export on, showed no notice at
        // all and left publishing silently dead for days.
        if (!isAbsolutePath(value)) {
          return "Use the full path, for example /Users/you/Dropbox/calendar or C:\\Users\\you\\Dropbox\\calendar.";
        }
        return undefined;
      }
    );

    if (this.plugin.settings.isPro && this.plugin.settings.publishEnabled && !this.plugin.settings.publishPath.trim()) {
      showFieldError(containerEl, "Publishing is on but no folder is set, so nothing is being published.");
    }
  }

  private proToggle(containerEl: HTMLElement, name: string, desc: string, key: ProToggleKey | null): void {
    const setting = new Setting(containerEl).setName(name).setDesc(desc);
    if (!this.plugin.settings.isPro) {
      this.lock(setting, name);
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

  private proText(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    key: ProTextKey,
    placeholder: string,
    validate?: (value: string) => string | undefined
  ): void {
    const setting = new Setting(containerEl).setName(name).setDesc(desc);
    if (!this.plugin.settings.isPro) {
      this.lock(setting, name);
      return;
    }
    let errorEl: HTMLElement | null = null;
    setting.addText((text) =>
      text.setPlaceholder(placeholder).setValue(this.plugin.settings[key]).onChange((value) => {
        errorEl?.remove();
        errorEl = null;
        const trimmed = value.trim();
        const error = validate?.(trimmed);
        if (error) {
          errorEl = showFieldError(setting.descEl, error);
          return;
        }
        this.plugin.settings[key] = trimmed;
        this.plugin.saveSettingsSoon();
      })
    );
  }

  /**
   * A locked row is a sales surface, not a dead row: give it a way to buy.
   *
   * The badge is a real element rather than CSS generated content, and each
   * button says what it unlocks — eight buttons whose entire accessible name was
   * the identical string "Get Pro" told a screen-reader user nothing.
   */
  private lock(setting: Setting, name: string): void {
    setting.settingEl.addClass("task-calendar-bridge-locked");
    setting.nameEl.createSpan({ text: "Pro", cls: "task-calendar-bridge-badge" });
    setting.addButton((button) => {
      button
        .setButtonText("Get Pro")
        .setTooltip("Unlock with a one-time license")
        .onClick(() => window.open(PURCHASE_URL, "_blank"));
      button.buttonEl.setAttr("aria-label", `Get Pro to unlock ${name.toLowerCase()}`);
    });
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

  // --- Feedback --------------------------------------------------------------

  private renderFeedback(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Feedback").setHeading();

    new Setting(containerEl)
      .setName("Bugs and feature requests")
      .setDesc("Issues and ideas are tracked on GitHub. Opens in your browser.")
      .addButton((button) =>
        button.setButtonText("Report a bug").onClick(() => {
          window.open("https://github.com/israerusan/obsidian-task-calendar-bridge/issues/new?labels=bug");
        })
      )
      .addButton((button) =>
        button.setButtonText("Request a feature").onClick(() => {
          window.open("https://github.com/israerusan/obsidian-task-calendar-bridge/issues/new?labels=enhancement");
        })
      );
  }
}
