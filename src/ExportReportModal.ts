import { App, Modal, Setting } from "obsidian";
import { SKIP_LABELS, type SkippedTask } from "./core";

export interface ExportReport {
  scope: string;
  path: string;
  eventCount: number;
  totalFound: number;
  capped: number;
  duplicateIds: number;
  skipped: SkippedTask[];
  publishedTo?: string;
  publishError?: string;
  isPro: boolean;
  freeLimit: number;
}

/**
 * Answers the question 1.0.x never answered: "why isn't my task in the
 * calendar?". Undated and malformed tasks used to vanish with no trace.
 */
export class ExportReportModal extends Modal {
  constructor(app: App, private readonly report: ExportReport) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, report } = this;
    contentEl.empty();
    // titleEl rather than setTitle(): setTitle is newer than manifest minAppVersion.
    this.titleEl.setText("Last calendar export");

    const summary = contentEl.createDiv({ cls: "task-calendar-bridge-report" });
    summary.createEl("p", { text: `${report.eventCount} event${report.eventCount === 1 ? "" : "s"} written to ${report.path} (${report.scope}).` });
    if (report.publishedTo) summary.createEl("p", { text: `Also published to ${report.publishedTo}.` });
    if (report.publishError) {
      summary.createEl("p", {
        text: `The calendar file was written, but publishing outside the vault failed: ${report.publishError}`,
        cls: "task-calendar-bridge-error",
      });
    }

    if (report.eventCount === 0) {
      summary.createEl("p", {
        text: "No tasks matched. Most calendar apps refuse to import an empty calendar file — add a due date to a task and export again.",
        cls: "task-calendar-bridge-error",
      });
    }

    if (report.capped > 0) {
      const upsell = contentEl.createDiv({ cls: "task-calendar-bridge-report" });
      upsell.createEl("p", {
        text: `Your vault has ${report.totalFound} dated tasks. The free tier exported the next ${report.freeLimit}; ${report.capped} were left out.`,
      });
      new Setting(contentEl).setName("Export every dated task").setDesc("A one-time Pro license removes the cap.").addButton((button) =>
        button
          .setButtonText("Get Pro")
          .setCta()
          .onClick(() => window.open("https://buymeacoffee.com/vaultspotlight/e/560210", "_blank"))
      );
    }

    if (report.duplicateIds > 0) {
      contentEl.createEl("p", {
        text: `${report.duplicateIds} task${report.duplicateIds === 1 ? "" : "s"} shared an id with another task and were left out. Give them different ids.`,
        cls: "task-calendar-bridge-error",
      });
    }

    if (report.skipped.length === 0) {
      contentEl.createEl("p", { text: "Nothing was skipped." });
      return;
    }

    const grouped = new Map<string, SkippedTask[]>();
    for (const item of report.skipped) {
      const label = SKIP_LABELS[item.reason];
      const list = grouped.get(label) ?? [];
      list.push(item);
      grouped.set(label, list);
    }

    contentEl.createEl("h3", { text: `Skipped (${report.skipped.length})` });
    for (const [label, items] of grouped) {
      contentEl.createEl("h4", { text: `${label} — ${items.length}` });
      const list = contentEl.createEl("ul", { cls: "task-calendar-bridge-report" });
      // Long lists are noise; the first few make the reason obvious.
      for (const item of items.slice(0, 15)) {
        const entry = list.createEl("li");
        entry.createEl("code", { text: `${item.sourcePath}:${item.line}` });
        entry.createSpan({ text: ` ${item.detail}` });
      }
      if (items.length > 15) list.createEl("li", { text: `…and ${items.length - 15} more.` });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
