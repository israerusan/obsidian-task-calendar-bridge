export type TaskStatus = "todo" | "done" | "cancelled" | "in-progress";

export interface Recurrence {
  /** RFC 5545 RRULE value, e.g. `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO`. */
  rrule: string;
  /** The literal text the rule was parsed from, for diagnostics. */
  source: string;
}

export interface CalendarTask {
  title: string;
  sourcePath: string;
  line: number;
  /** The date the event is placed on. */
  date: string;
  /** Deadline, when it differs from `date` (Tasks users often set both). */
  dueDate?: string;
  endDate?: string;
  startTime?: string;
  durationMinutes?: number;
  reminderMinutes?: number;
  /** 1 (highest) to 9 (lowest), RFC 5545 §3.8.1.9. Undefined means unset. */
  priority?: number;
  tags: string[];
  recurrence?: Recurrence;
  status: TaskStatus;
  /**
   * Identity that survives editing: an explicit id, a block id, or a hash of
   * path + title + occurrence. Never contains the line number.
   */
  stableId: string;
  raw: string;
}

export type SkipReason =
  | "no-date"
  | "invalid-date"
  | "invalid-time"
  | "invalid-duration"
  | "line-too-long"
  | "repeat-not-enabled"
  | "invalid-range"
  | "completed"
  | "cancelled"
  | "unsupported-recurrence";

export interface SkippedTask {
  sourcePath: string;
  line: number;
  reason: SkipReason;
  detail: string;
  excerpt: string;
  /**
   * True when the task did not reach the calendar at all. A false value means
   * one field was dropped and the event was still exported — reporting those as
   * "could not be exported" made a healthy export look broken.
   */
  fatal: boolean;
}

export interface ParseResult {
  tasks: CalendarTask[];
  skipped: SkippedTask[];
}

export interface ParseOptions {
  includeCompleted: boolean;
  /** Recurrence is a Pro capability; free exports drop the rule but keep the task. */
  includeRecurrence: boolean;
}

export type TimeMode = "floating" | "zoned";

export interface IcsOptions {
  calendarName: string;
  productId: string;
  includeReminders: boolean;
  defaultDurationMinutes: number;
  /** `floating` keeps 09:30 as 09:30 everywhere; `zoned` pins it to an instant. */
  timeMode: TimeMode;
  timeZone: string;
  /** Time of day an all-day reminder fires, `HH:mm`. */
  allDayReminderTime: string;
  /** Vault name, needed for a working `obsidian://open?vault=…&file=…` link. */
  vaultName: string;
  exportTags: boolean;
}

export const SKIP_LABELS: Record<SkipReason, string> = {
  "no-date": "No date",
  "invalid-date": "Invalid date",
  "invalid-time": "Invalid time",
  "invalid-duration": "Invalid duration",
  "line-too-long": "Line too long",
  "repeat-not-enabled": "Repeating tasks are off",
  "invalid-range": "End before start",
  completed: "Completed",
  cancelled: "Cancelled",
  "unsupported-recurrence": "Unsupported repeat rule",
};
