import { App, MarkdownView, Modal, Setting, TFile } from "obsidian";
import { SKIP_LABELS, type SkippedTask } from "./core";
import { PURCHASE_URL } from "./settings";

/** A task dropped because another task already claimed the same identity. */
export interface DuplicateIdentity {
  sourcePath: string;
  line: number;
  title: string;
}

/**
 * How many tasks fell into each bucket across the WHOLE export.
 *
 * Counted separately from the sample rows below, which are capped: the headings
 * have to state the real totals even when the list shows the first few hundred.
 */
export interface SkipCounts {
  /** Did not reach the calendar, and the user did not ask for that. */
  lost: number;
  /** Exported, but one field of it could not be read. */
  warnings: number;
  /** Left out on purpose by a setting. Working as configured. */
  excluded: number;
}

export interface ExportReport {
  scope: string;
  path: string;
  eventCount: number;
  totalFound: number;
  capped: number;
  duplicateIds: DuplicateIdentity[];
  /** A sample, capped for memory. `counts` holds the real totals. */
  skipped: SkippedTask[];
  counts: SkipCounts;
  publishedTo?: string;
  publishError?: string;
  isPro: boolean;
  freeLimit: number;
}

/** Excluded on purpose by a setting, rather than lost. */
const BY_SETTING = new Set(["completed", "cancelled", "repeat-not-enabled", "reminder-not-enabled"]);

/** One pass, three buckets — the classification every surface has to agree on. */
export function countSkips(skipped: SkippedTask[]): SkipCounts {
  const counts: SkipCounts = { lost: 0, warnings: 0, excluded: 0 };
  for (const item of skipped) {
    if (!item.fatal) BY_SETTING.has(item.reason) ? counts.excluded++ : counts.warnings++;
    else if (BY_SETTING.has(item.reason)) counts.excluded++;
    else counts.lost++;
  }
  return counts;
}

/**
 * Answers the question 1.0.x never answered: "why isn't my task in the
 * calendar?". Undated and malformed tasks used to vanish with no trace.
 *
 * 1.1.0 answered it but buried it: one flat "Skipped (401)" list mixed the one
 * task that was actually lost with 400 completed checkboxes excluded by a
 * setting, so a healthy export read like a broken one and the entry the user
 * came for was scrolled off the bottom.
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
      this.error(summary, `The calendar file was written, but publishing outside the vault failed: ${report.publishError}`);
    }

    if (report.eventCount === 0) {
      this.error(
        summary,
        "No tasks matched. Most calendar apps refuse to import an empty calendar file — add a due date to a task and export again."
      );
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
          // The constant, not a copy: the checkout link moved once already, and
          // this button was the one surface that kept opening the old one.
          .onClick(() => window.open(PURCHASE_URL, "_blank"))
      );
    }

    if (report.duplicateIds.length > 0) {
      const section = contentEl.createDiv({ cls: "task-calendar-bridge-report" });
      this.error(
        section,
        `${report.duplicateIds.length} task${report.duplicateIds.length === 1 ? "" : "s"} shared an identity with an earlier task and ${report.duplicateIds.length === 1 ? "was" : "were"} left out. Two tasks with the same [id:: …] anywhere in the vault are one event; give them different ids.`
      );
      // Naming which tasks collided, not just how many: a bare count left the
      // user to search the whole vault for two ids they could not see.
      const list = section.createEl("ul", { cls: "task-calendar-bridge-report" });
      for (const item of report.duplicateIds.slice(0, 15)) {
        this.entry(list, item.sourcePath, item.line, ` ${item.title}`);
      }
      if (report.duplicateIds.length > 15) list.createEl("li", { text: `…and ${report.duplicateIds.length - 15} more.` });
    }

    const lost = report.skipped.filter((item) => item.fatal && !BY_SETTING.has(item.reason));
    const warnings = report.skipped.filter((item) => !item.fatal && !BY_SETTING.has(item.reason));
    const excluded = report.skipped.filter((item) => BY_SETTING.has(item.reason));

    if (report.counts.lost === 0 && report.counts.warnings === 0) {
      contentEl.createEl("p", { text: "Every dated task was exported." });
    }

    // Ordered by what the user came to find out. "Not exported" first, always.
    // The headings carry the true totals; the lists below are a sample.
    this.group(contentEl, `Not exported (${report.counts.lost})`, lost, report.counts.lost, "These tasks are not in your calendar.");
    this.group(
      contentEl,
      `Exported with a field ignored (${report.counts.warnings})`,
      warnings,
      report.counts.warnings,
      "These tasks are in your calendar, but one field of each could not be read."
    );
    this.group(contentEl, `Excluded by your settings (${report.counts.excluded})`, excluded, report.counts.excluded, "Working as configured — not a problem.");
  }

  private group(container: HTMLElement, heading: string, items: SkippedTask[], total: number, blurb: string): void {
    if (total === 0) return;
    container.createEl("h3", { text: heading });
    container.createEl("p", { text: blurb, cls: "task-calendar-bridge-report" });

    const byReason = new Map<string, SkippedTask[]>();
    for (const item of items) {
      const label = SKIP_LABELS[item.reason];
      const list = byReason.get(label) ?? [];
      list.push(item);
      byReason.set(label, list);
    }

    for (const [label, group] of byReason) {
      container.createEl("h4", { text: `${label} — ${group.length}` });
      const list = container.createEl("ul", { cls: "task-calendar-bridge-report" });
      // Long lists are noise; the first few make the reason obvious.
      for (const item of group.slice(0, 15)) {
        this.entry(list, item.sourcePath, item.line, ` ${item.detail}`);
      }
      if (group.length > 15) list.createEl("li", { text: `…and ${group.length - 15} more.` });
    }
  }

  /**
   * One report row, with the source location as a real link.
   *
   * It used to be inert `<code>`, so acting on the report meant closing the
   * modal and hunting for the note and line by hand, once per entry — which is
   * why most people read this report exactly once.
   */
  private entry(list: HTMLElement, sourcePath: string, line: number, detail: string): void {
    const row = list.createEl("li");
    const link = row.createEl("a", { text: `${sourcePath}:${line}`, href: "#", cls: "task-calendar-bridge-jump" });
    link.setAttr("aria-label", `Open ${sourcePath} at line ${line}`);
    link.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      void this.jumpTo(sourcePath, line);
    });
    row.createSpan({ text: detail });
  }

  private async jumpTo(sourcePath: string, line: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;
    this.close();
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const target = { line: Math.max(0, line - 1), ch: 0 };
    view.editor.setCursor(target);
    view.editor.scrollIntoView({ from: target, to: target }, true);
  }

  private error(host: HTMLElement, message: string): void {
    // Announced, not merely coloured: an error a screen reader never reads out
    // and a colour-blind user cannot distinguish is not an error message.
    const el = host.createEl("p", { text: message, cls: "task-calendar-bridge-error" });
    el.setAttr("role", "alert");
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
