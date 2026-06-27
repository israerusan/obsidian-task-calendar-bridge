import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { build } from "esbuild";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1"));
const outfile = path.join(os.tmpdir(), `task-calendar-core-${Date.now()}.mjs`);

await build({
  entryPoints: [path.join(root, "src/core/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2018",
  outfile,
});

const core = await import(`file://${outfile.replace(/\\/g, "/")}`);
const { parseTasksFromMarkdown, generateIcsCalendar, createStableUid, filterTasksForTier } = core;

const markdown = `# Project Alpha

- [ ] Ship landing page 📅 2026-07-02 #client
- [x] Done task 📅 2026-07-03
- [ ] Call Alice [due:: 2026-07-04] [start:: 09:30] [duration:: 45m] [reminder:: 30m]
- [ ] Missing date should not export
- [ ] Multi-day workshop [due:: 2026-07-05] [end:: 2026-07-06]
`;

const tasks = parseTasksFromMarkdown(markdown, "Projects/Alpha.md", { includeCompleted: false });
assert.equal(tasks.length, 3, "parser should return incomplete tasks with due dates");
assert.deepEqual(tasks.map((task) => task.title), ["Ship landing page", "Call Alice", "Multi-day workshop"]);
assert.equal(tasks[0].dueDate, "2026-07-02");
assert.equal(tasks[0].sourcePath, "Projects/Alpha.md");
assert.equal(tasks[0].line, 3);
assert.equal(tasks[1].startTime, "09:30");
assert.equal(tasks[1].durationMinutes, 45);
assert.equal(tasks[1].reminderMinutes, 30);
assert.equal(tasks[2].endDate, "2026-07-06");

const completed = parseTasksFromMarkdown(markdown, "Projects/Alpha.md", { includeCompleted: true });
assert.equal(completed.length, 4, "includeCompleted should preserve checked due tasks");
assert.equal(completed[1].completed, true);

const freeTasks = filterTasksForTier(tasks, { isPro: false, maxFreeTasks: 2 });
assert.equal(freeTasks.length, 2, "free tier should cap exported full-vault tasks");
const proTasks = filterTasksForTier(tasks, { isPro: true, maxFreeTasks: 2 });
assert.equal(proTasks.length, 3, "pro tier should not cap exported tasks");

assert.equal(createStableUid(tasks[0]), createStableUid({ ...tasks[0] }), "UIDs should be deterministic");
assert.notEqual(createStableUid(tasks[0]), createStableUid(tasks[1]), "different tasks need different UIDs");

const ics = generateIcsCalendar(tasks, {
  calendarName: "Obsidian Tasks",
  productId: "-//Task Calendar Bridge//EN",
  includeReminders: true,
  defaultDurationMinutes: 30,
});
assert.ok(ics.startsWith("BEGIN:VCALENDAR"));
assert.ok(ics.includes("X-WR-CALNAME:Obsidian Tasks"));
assert.ok(ics.includes("SUMMARY:Ship landing page"));
assert.ok(ics.includes("DTSTART;VALUE=DATE:20260702"), "all-day due task should become date event");
assert.ok(ics.includes("DTSTART:20260704T093000"), "timed task should include local start time");
assert.ok(ics.includes("DURATION:PT45M"), "timed task should preserve duration");
assert.ok(ics.includes("TRIGGER:-PT30M"), "Pro reminders should be serializable");
assert.ok(ics.includes("DESCRIPTION:Source: obsidian://open?path=Projects%2FAlpha.md%23L5"));
assert.ok(ics.endsWith("END:VCALENDAR\r\n"));

fs.unlinkSync(outfile);
console.log("core tests passed");
