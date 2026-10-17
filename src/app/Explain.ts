import { createUid, explainSkips, explainTask, isTaskLine, parseTasksFromMarkdown, type ExplainOptions, type ExplainRow, type ParseOptions } from "../core";
import type { PreviewState } from "./CalendarPreview";

/**
 * The verdict for one line of one note, built from the same parse the export runs.
 *
 * Pure, so every branch below — and they are exactly the ways a task fails to reach the
 * calendar — is pinned by a test instead of being discovered by a confused user.
 */

export interface ExplainLineInput {
  markdown: string;
  sourcePath: string;
  /** 1-based, as the parser and the report count lines. */
  line: number;
  parseOptions: ParseOptions;
  explainOptions: ExplainOptions;
  /** Whether the folder filters let this note into the whole-vault calendar. */
  inVaultScope: boolean;
  /**
   * Where the whole-vault export puts this task. Given the location AND the identity: line
   * numbers alone go wrong when the editor holds unsaved lines the preview has not seen, and
   * identity alone is ambiguous in exactly the duplicate case.
   */
  vaultState?: (sourcePath: string, line: number, uid: string) => PreviewState | undefined;
  freeLimit: number;
}

export interface LineExplanation {
  headline: string;
  excluded: boolean;
  rows: ExplainRow[];
  issues: ExplainRow[];
  source: string;
}

export function explainLine(input: ExplainLineInput): LineExplanation {
  const lines = input.markdown.split(/\r?\n/);
  const source = (lines[input.line - 1] ?? "").trim();
  const result = parseTasksFromMarkdown(input.markdown, input.sourcePath, input.parseOptions);
  const task = result.tasks.find((candidate) => candidate.line === input.line);
  const skipped = result.skipped.filter((item) => item.line === input.line);
  const issues = explainSkips(skipped);

  if (!task) {
    const fatal = skipped.find((item) => item.fatal);
    if (fatal) return { headline: `Not exported: ${issues[0]?.label.toLowerCase() ?? "skipped"}.`, excluded: true, rows: [], issues, source };
    if (isTaskLine(source)) {
      return { headline: "Not exported: this task is inside a code block, so it is treated as an example.", excluded: true, rows: [], issues, source };
    }
    return { headline: "This line is not a task. Put the cursor on a line such as “- [ ] Call Sam 📅 2026-10-20”.", excluded: true, rows: [], issues, source };
  }

  const rows = explainTask(task, input.explainOptions);

  if (!input.inVaultScope) {
    return {
      headline: "Not in the vault calendar: this note is outside your folder filters. Exporting just this note still includes it.",
      excluded: true,
      rows,
      issues,
      source,
    };
  }

  const state = input.vaultState?.(task.sourcePath, task.line, createUid(task));
  if (state === "capped") {
    return {
      headline: `Not in the vault calendar yet: the free tier exports the next ${input.freeLimit} dated tasks, and this one is further out. Exporting just this note includes it.`,
      excluded: true,
      rows,
      issues,
      source,
    };
  }
  if (state === "duplicate") {
    return {
      headline: "Not in the vault calendar: another task has the same identity. Give one of them a different [id:: …].",
      excluded: true,
      rows,
      issues,
      source,
    };
  }

  // "Exports as", not "is in your calendar": this describes what the next export writes, and the
  // file on disk may not have been written since the task was.
  return {
    headline: issues.length > 0 ? "Exports as a calendar event, with something on this line ignored:" : "Exports as a calendar event:",
    excluded: false,
    rows,
    issues,
    source,
  };
}
