import { App, Modal, Setting } from "obsidian";
import { CHANGELOG_URL, type ReleaseNotes } from "../core";

/**
 * The highlights of the releases since this vault last saw any.
 *
 * Shown once per update, never on a fresh install (the first-run view covers that) and never on
 * a downgrade. Everything a user needs to stop it is on the modal itself.
 */
export class WhatsNewModal extends Modal {
  constructor(
    app: App,
    private readonly notes: ReleaseNotes[],
    private readonly options: { showOnUpdate: boolean; setShowOnUpdate: (value: boolean) => void; openCalendar: () => void }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("tcb-whats-new");
    const newest = this.notes[0]?.version ?? "";
    this.titleEl.setText(`What's new in Task Calendar Bridge ${newest}`);

    for (const release of this.notes) {
      if (this.notes.length > 1) contentEl.createEl("h3", { text: release.version });
      const list = contentEl.createEl("ul", { cls: "tcb-highlights" });
      for (const highlight of release.highlights) {
        const item = list.createEl("li");
        item.createEl("strong", { text: highlight.title });
        item.createEl("p", { text: highlight.body });
      }
    }

    const more = contentEl.createEl("p", { cls: "tcb-muted" });
    more.appendText("Every fix and change is in the ");
    const link = more.createEl("a", { text: "full changelog", href: CHANGELOG_URL });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener");
    more.appendText(".");

    new Setting(contentEl)
      .setName("Show release notes after updates")
      .setDesc("You can always open them again with the command “Show what's new”.")
      .addToggle((toggle) => toggle.setValue(this.options.showOnUpdate).onChange((value) => this.options.setShowOnUpdate(value)));

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Open the task calendar")
          .setCta()
          .onClick(() => {
            this.close();
            this.options.openCalendar();
          })
      )
      .addButton((button) => button.setButtonText("Close").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
