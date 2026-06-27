import { App, Modal } from "obsidian";
import { IMPORT_GUIDE_MARKDOWN } from "./core/help";

export class HelpModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("task-calendar-bridge-help");

    const sections = IMPORT_GUIDE_MARKDOWN.split(/\n(?=## )/);
    const title = sections.shift() ?? "Task Calendar Bridge setup";
    contentEl.createEl("h2", { text: title.replace(/^#\s*/, "") });

    for (const section of sections) {
      const lines = section.trim().split("\n");
      const heading = lines.shift() ?? "";
      contentEl.createEl("h3", { text: heading.replace(/^##\s*/, "") });
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("- [ ]")) {
          contentEl.createEl("code", { text: trimmed });
          contentEl.createEl("br");
        } else {
          contentEl.createEl("p", { text: trimmed });
        }
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
