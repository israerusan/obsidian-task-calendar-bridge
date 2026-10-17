import { createUid } from "./ics";
import { SKIP_LABELS, type CalendarTask, type SkippedTask, type TimeMode } from "./types";

/**
 * One task, described the way the calendar will see it.
 *
 * "Why does this event look like that?" and "why is this task not in my calendar?" were only
 * answerable by exporting, opening the report, and finding the line. Asking the task directly
 * answers both from the editor, and the answer is computed from the same parse the export uses.
 */

export interface ExplainRow {
  label: string;
  value: string;
}

export interface ExplainOptions {
  defaultDurationMinutes: number;
  allDayReminderTime: string;
  timeMode: TimeMode;
  timeZone: string;
  exportTags: boolean;
}

export type IdentitySource = "explicit" | "block" | "derived";

/** Where an event's identity comes from — which decides what kind of edit creates a new event. */
export function identitySource(task: CalendarTask): IdentitySource {
  if (task.stableId.startsWith(`${task.sourcePath}#^`)) return "block";
  // A derived identity is `h` plus a 16-hex-digit hash; anything else came from [id:: …] or 🆔.
  if (/^h[0-9a-f]{16}$/.test(task.stableId)) return "derived";
  return "explicit";
}

const PRIORITY_NAMES = new Map<number, string>([
  [1, "highest"],
  [2, "high"],
  [4, "medium"],
  [7, "low"],
  [9, "lowest"],
]);

export function formatMinutes(total: number): string {
  if (total % 1440 === 0) return `${total / 1440} day${total === 1440 ? "" : "s"}`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

export function explainTask(task: CalendarTask, options: ExplainOptions): ExplainRow[] {
  const rows: ExplainRow[] = [];
  const multiDay = task.endDate && task.endDate !== task.date ? ` to ${task.endDate}` : "";

  if (task.startTime) {
    const minutes = task.durationMinutes && task.durationMinutes > 0 ? task.durationMinutes : options.defaultDurationMinutes;
    const fallback = task.durationMinutes && task.durationMinutes > 0 ? "" : " (the default duration)";
    const zone = options.timeMode === "zoned" && options.timeZone ? ` in ${options.timeZone}` : " local wall time";
    rows.push({ label: "When", value: `${task.date}${multiDay} at ${task.startTime}${zone}` });
    rows.push({ label: "Duration", value: `${formatMinutes(minutes)}${fallback}` });
  } else {
    rows.push({ label: "When", value: `All day, ${task.date}${multiDay}` });
  }

  if (task.dueDate) rows.push({ label: "Deadline", value: `${task.dueDate} — the event sits on ${task.date}, the due date travels with it` });
  if (task.recurrence) rows.push({ label: "Repeats", value: `${task.recurrence.source} — RRULE ${task.recurrence.rrule}` });

  if (task.reminderMinutes && task.reminderMinutes > 0) {
    rows.push({
      label: "Reminder",
      value: task.startTime
        ? `${formatMinutes(task.reminderMinutes)} before`
        : `${formatMinutes(task.reminderMinutes)} before ${options.allDayReminderTime} (the all-day reminder time)`,
    });
  }

  if (task.priority !== undefined) rows.push({ label: "Priority", value: `${PRIORITY_NAMES.get(task.priority) ?? task.priority} (${task.priority})` });
  if (task.tags.length > 0) {
    rows.push({ label: "Categories", value: options.exportTags ? task.tags.join(", ") : `none — “Export tags as categories” is off` });
  }
  if (task.status !== "todo") {
    const labels: Record<CalendarTask["status"], string> = { todo: "open", done: "completed", cancelled: "cancelled", "in-progress": "in progress" };
    rows.push({ label: "Status", value: labels[task.status] });
  }

  const source = identitySource(task);
  const stability =
    source === "explicit"
      ? "from its id — survives any edit, including moving the note"
      : source === "block"
        ? "from its block id — survives edits and moving the line"
        : "from the note path and title — renaming the note or editing the title makes it a new event. Add a ^block-id to the line to pin it";
  rows.push({ label: "Identity", value: `${createUid(task)}, ${stability}` });
  return rows;
}

/** The skip records for one line, worded for someone looking at that line. */
export function explainSkips(skipped: SkippedTask[]): ExplainRow[] {
  return skipped.map((item) => ({ label: SKIP_LABELS[item.reason], value: item.detail }));
}
