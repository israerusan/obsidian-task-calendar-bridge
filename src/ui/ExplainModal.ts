import { App, Modal } from "obsidian";
import type { ExplainRow } from "../core";

export interface Explanation {
  /** One line: the verdict a user is looking for first. */
  headline: string;
  /** True when the task is not in the calendar file. */
  excluded: boolean;
  rows: ExplainRow[];
  /** Problems found on the line, worded for the line. */
  issues: ExplainRow[];
  /** The task line, verbatim. */
  source: string;
}

/** "How does this task export?", answered from the same parse the export runs. */
export class ExplainModal extends Modal {
  constructor(
    app: App,
    private readonly explanation: Explanation
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, explanation } = this;
    contentEl.empty();
    contentEl.addClass("tcb-explain");
    this.titleEl.setText("Calendar event");

    contentEl.createEl("code", { cls: "tcb-explain-source", text: explanation.source });
    const headline = contentEl.createEl("p", { cls: explanation.excluded ? "task-calendar-bridge-error" : "tcb-explain-headline", text: explanation.headline });
    if (explanation.excluded) headline.setAttr("role", "alert");

    if (explanation.rows.length > 0) this.table(contentEl, explanation.rows);
    if (explanation.issues.length > 0) {
      contentEl.createEl("h4", { text: explanation.excluded ? "Why" : "Ignored on this line" });
      this.table(contentEl, explanation.issues);
    }
  }

  private table(container: HTMLElement, rows: ExplainRow[]): void {
    const list = container.createEl("dl", { cls: "tcb-explain-rows" });
    for (const row of rows) {
      list.createEl("dt", { text: row.label });
      list.createEl("dd", { text: row.value });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
