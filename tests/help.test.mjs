import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// fileURLToPath, not URL.pathname: the latter is percent-encoded, so a clone
// under a path containing a space resolved to a directory that does not exist,
// and esbuild failed with 'could not resolve entry point' instead of saying so.
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outfile = path.join(os.tmpdir(), `task-calendar-help-${Date.now()}.mjs`);

// The whole of core, not just help.ts: the point of this file is to check the
// documentation against the parser rather than against itself.
await build({
  entryPoints: [path.join(root, "src/core/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2018",
  outfile,
});

const core = await import(`file://${outfile.replace(/\\/g, "/")}`);
const { IMPORT_GUIDE_MARKDOWN, SAMPLE_TASK_NOTE, parseTasksFromMarkdown, DEFAULT_VAULT_OUTPUT_PATH, DEFAULT_CURRENT_NOTE_OUTPUT_PATH } = core;

const PRO = { includeCompleted: true, includeRecurrence: true, includeReminders: true };
const FREE = { includeCompleted: false, includeRecurrence: false, includeReminders: false };

for (const app of ["Google Calendar", "Apple Calendar", "Outlook", "TickTick"]) {
  assert.ok(IMPORT_GUIDE_MARKDOWN.includes(app), `guide must cover ${app}`);
}

// Compared against the constants the plugin actually uses, not against copies of
// them: changing a default used to leave this green and the guide wrong, and the
// guide is the only place that documents where the export lands.
assert.ok(IMPORT_GUIDE_MARKDOWN.includes(DEFAULT_VAULT_OUTPUT_PATH), "guide must name the real full-vault default");
assert.ok(IMPORT_GUIDE_MARKDOWN.includes(DEFAULT_CURRENT_NOTE_OUTPUT_PATH), "guide must name the real current-note default");
assert.ok(/subscrib/i.test(IMPORT_GUIDE_MARKDOWN), "the guide must explain subscribing, not only importing");
assert.ok(IMPORT_GUIDE_MARKDOWN.includes("Show last export report"), "users need to be told how to find skipped tasks");

// The subscribe instructions are the reason people buy Pro, and the plain share
// link from each of these services is a preview page a calendar app cannot read.
assert.ok(/\?raw=1|\?dl=1/.test(IMPORT_GUIDE_MARKDOWN), "Dropbox needs the raw-file form of the link");
assert.ok(IMPORT_GUIDE_MARKDOWN.includes("?download=1"), "OneDrive needs the direct-download form of the link");
assert.ok(/iCloud Drive cannot/.test(IMPORT_GUIDE_MARKDOWN), "iCloud Drive offers no subscribable URL and the guide must say so");
// Outlook split into new and classic in ways that changed the import path.
assert.ok(IMPORT_GUIDE_MARKDOWN.includes("New Outlook"), "the guide must cover new Outlook, not only the classic File menu");
assert.ok(IMPORT_GUIDE_MARKDOWN.includes("Classic Outlook"));

// Every repeat rule the guide advertises must be one the parser can translate.
const advertised = IMPORT_GUIDE_MARKDOWN.split("## Repeat rules that are understood")[1] ?? "";
assert.ok(advertised, "the guide must document which repeat rules work");
for (const line of advertised.split("\n")) {
  const bullet = /^-\s+(every .*)$/.exec(line.trim());
  if (!bullet) continue;
  for (const rule of bullet[1].split(" / ")) {
    const parsed = core.parseRecurrence(rule.trim());
    assert.ok(parsed, `the guide advertises "${rule.trim()}" but the parser cannot translate it`);
  }
}

// The sample note is written into a new user's vault verbatim, so assert what the
// parser makes of it rather than grepping it for substrings — fencing a whole
// section would have kept every old substring assertion green while silently
// deleting the examples it claims to demonstrate.
const pro = parseTasksFromMarkdown(SAMPLE_TASK_NOTE, "Task Calendar Bridge Sample.md", PRO);
const byTitle = new Map(pro.tasks.map((task) => [task.title, task]));

assert.equal(byTitle.get("Simple all-day task").date, "2026-08-01");
assert.deepEqual(byTitle.get("Simple all-day task").tags, ["calendar"]);
assert.equal(byTitle.get("Scheduled beats due for placement").date, "2026-08-04");
assert.equal(byTitle.get("Scheduled beats due for placement").dueDate, "2026-08-06");
assert.equal(byTitle.get("Multi-day workshop").endDate, "2026-08-05");
assert.equal(byTitle.get("Timed call").startTime, "14:15");
assert.equal(byTitle.get("Timed call").durationMinutes, 60);
assert.equal(byTitle.get("Reminder alarm, Pro").reminderMinutes, 10);
assert.equal(byTitle.get("High-priority review").priority, 2);
assert.equal(byTitle.get("Weekly one-to-one, Pro").recurrence.rrule, "FREQ=WEEKLY;BYDAY=MO");
assert.equal(byTitle.get("Fortnightly planning, Pro").recurrence.rrule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR");
assert.equal(byTitle.get("Monthly board meeting, Pro").recurrence.rrule, "FREQ=MONTHLY;BYDAY=1MO");
assert.equal(byTitle.get("Completed task, exported with Pro").status, "done");
assert.equal(byTitle.get("Cancelled task, exported with Pro").status, "cancelled");
assert.equal(byTitle.get("In-progress task").status, "in-progress");
assert.equal(byTitle.get("Task with a block id").stableId, "Task Calendar Bridge Sample.md#^sample-block");
assert.equal(byTitle.get("Task with an explicit id").stableId, "sample-task");

// Exactly one example is meant to fail, and it is meant to fail for that reason.
const fatal = pro.skipped.filter((item) => item.fatal);
assert.equal(fatal.length, 1, `sample note should lose exactly one task, lost ${fatal.length}`);
assert.equal(fatal[0].reason, "no-date");

// On the free tier the Pro examples must degrade the way the sample says they do.
const free = parseTasksFromMarkdown(SAMPLE_TASK_NOTE, "Task Calendar Bridge Sample.md", FREE);
assert.ok(free.skipped.some((item) => item.reason === "repeat-not-enabled" && !item.fatal));
assert.ok(free.skipped.some((item) => item.reason === "reminder-not-enabled" && !item.fatal));
assert.ok(free.skipped.some((item) => item.reason === "completed"));
assert.ok(!free.tasks.some((task) => task.recurrence), "the free tier must not emit a recurrence rule");

fs.unlinkSync(outfile);
console.log("help tests passed");
