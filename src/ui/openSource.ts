import { App, MarkdownView, TFile, type PaneType } from "obsidian";

/**
 * Open a note with the cursor on a task's line.
 *
 * Shared by the export report and the calendar view, which both list tasks by where they came
 * from. `newLeaf` follows Obsidian's own convention: a modifier-click opens a new tab rather
 * than replacing what the user was reading.
 */
export async function openTaskSource(app: App, sourcePath: string, line: number, newLeaf: PaneType | boolean = false): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return false;
  const leaf = app.workspace.getLeaf(newLeaf);
  await leaf.openFile(file);
  const view = leaf.view;
  if (!(view instanceof MarkdownView)) return true;
  const target = { line: Math.max(0, line - 1), ch: 0 };
  view.editor.setCursor(target);
  view.editor.scrollIntoView({ from: target, to: target }, true);
  return true;
}
