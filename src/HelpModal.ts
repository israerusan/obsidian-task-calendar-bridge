import { App, Modal } from "obsidian";
import { IMPORT_GUIDE_MARKDOWN } from "./core/help";

/**
 * Renders the setup guide.
 *
 * It used to split the text on `## ` and pass the ENTIRE first section — title,
 * intro, the default output paths, and the "run an export first" instruction —
 * into a single `<h2>`, so the plugin's only onboarding surface opened with a
 * 400-character wall of bold text where its title should be. Bullets rendered as
 * paragraphs with a literal "- " in front of them.
 */
export class HelpModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("task-calendar-bridge-help");

    const sections = IMPORT_GUIDE_MARKDOWN.split(/\n(?=## )/);
    const intro = (sections.shift() ?? "").split("\n");
    const title = intro.shift() ?? "Task Calendar Bridge setup";
    contentEl.createEl("h2", { text: title.replace(/^#\s*/, "") });
    this.renderBody(contentEl, intro);

    for (const section of sections) {
      const lines = section.trim().split("\n");
      const heading = lines.shift() ?? "";
      contentEl.createEl("h3", { text: heading.replace(/^##\s*/, "") });
      this.renderBody(contentEl, lines);
    }
  }

  /** Paragraphs, real bullet lists, and task examples as code. */
  private renderBody(container: HTMLElement, lines: string[]): void {
    let list: HTMLElement | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        list = null;
        continue;
      }

      // A task example is the one thing that must be shown verbatim.
      if (/^-\s*\[.\]/.test(trimmed)) {
        list = null;
        container.createEl("code", { text: trimmed });
        container.createEl("br");
        continue;
      }

      const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
      if (bullet) {
        list ??= container.createEl("ul");
        list.createEl("li", { text: bullet[1] });
        continue;
      }

      list = null;
      container.createEl("p", { text: trimmed });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
