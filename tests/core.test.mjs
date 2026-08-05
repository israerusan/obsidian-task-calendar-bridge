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
const {
  parseTasksFromMarkdown,
  generateIcsCalendar,
  createUid,
  selectUpcoming,
  compareTasks,
  parseRecurrence,
  validateOutputPath,
  isInFolder,
  isValidDate,
  normalizeTime,
  formatZonedDateTimeAsUtc,
  buildObsidianUri,
  foldIcsLine,
  FREE_TASK_LIMIT,
  buildVtimezone,
  escapeIcsText,
  localToday,
} = core;

const PRO = { includeCompleted: true, includeRecurrence: true, includeReminders: true };
const FREE = { includeCompleted: false, includeRecurrence: false, includeReminders: false };

const ICS_OPTIONS = {
  calendarName: "Obsidian Tasks",
  productId: "-//Task Calendar Bridge//EN",
  defaultDurationMinutes: 30,
  timeMode: "floating",
  timeZone: "",
  allDayReminderTime: "09:00",
  vaultName: "My Vault",
  exportTags: true,
  linkToSource: true,
};

const parse = (markdown, file = "Projects/Alpha.md", options = FREE) => parseTasksFromMarkdown(markdown, file, options);
const ics = (tasks, overrides = {}) => generateIcsCalendar(tasks, { ...ICS_OPTIONS, ...overrides }, new Date("2026-01-01T00:00:00Z")).ics;

// --- Baseline parsing --------------------------------------------------------

{
  const markdown = `# Project Alpha

- [ ] Ship landing page 📅 2026-07-02 #client
- [x] Done task 📅 2026-07-03
- [ ] Call Alice [due:: 2026-07-04] [start:: 09:30] [duration:: 45m] [reminder:: 30m]
- [ ] Missing date should not export
- [ ] Multi-day workshop [due:: 2026-07-05] [end:: 2026-07-06]
`;

  const { tasks, skipped } = parse(markdown);
  assert.deepEqual(tasks.map((t) => t.title), ["Ship landing page", "Call Alice", "Multi-day workshop"]);
  assert.equal(tasks[0].date, "2026-07-02");
  assert.deepEqual(tasks[0].tags, ["client"]);
  assert.equal(tasks[1].startTime, "09:30");
  assert.equal(tasks[1].durationMinutes, 45);
  assert.equal(tasks[2].endDate, "2026-07-06");

  assert.ok(skipped.some((s) => s.reason === "no-date"), "undated tasks are reported, not silently dropped");
  assert.ok(skipped.some((s) => s.reason === "completed"), "completed tasks are reported when excluded");

  // An alarm the free tier cannot set is REPORTED, not silently dropped. It used
  // to disappear inside the ICS layer, which has no way to say anything, so the
  // report claimed nothing had been skipped at all.
  assert.equal(tasks[1].reminderMinutes, undefined);
  const reminderSkip = skipped.find((s) => s.reason === "reminder-not-enabled");
  assert.ok(reminderSkip, "a dropped alarm must appear in the report");
  assert.equal(reminderSkip.fatal, false, "the task itself was still exported");

  const withCompleted = parse(markdown, "Projects/Alpha.md", PRO);
  assert.equal(withCompleted.tasks.length, 4);
  assert.equal(withCompleted.tasks.find((t) => t.title === "Done task").status, "done");
  assert.equal(withCompleted.tasks.find((t) => t.title === "Call Alice").reminderMinutes, 30, "Pro keeps the alarm");
  assert.ok(!withCompleted.skipped.some((s) => s.reason === "reminder-not-enabled"));
}

// --- UID stability: the defect that duplicated events on every edit ----------

{
  const before = parse("- [ ] Ship landing page [due:: 2026-07-02]").tasks[0];

  const afterLineInsert = parse("# Heading\n\n- [ ] Ship landing page [due:: 2026-07-02]").tasks[0];
  assert.equal(createUid(afterLineInsert), createUid(before), "inserting a line above must not change the UID");

  const afterReschedule = parse("- [ ] Ship landing page [due:: 2026-09-30]").tasks[0];
  assert.equal(createUid(afterReschedule), createUid(before), "rescheduling must update the event, not duplicate it");

  const afterTimeAdded = parse("- [ ] Ship landing page [due:: 2026-07-02] [start:: 10:00]").tasks[0];
  assert.equal(createUid(afterTimeAdded), createUid(before), "adding a time must not change the UID");

  const afterCompletion = parse("- [x] Ship landing page [due:: 2026-07-02]", "Projects/Alpha.md", PRO).tasks[0];
  assert.equal(createUid(afterCompletion), createUid(before), "completing a task must not change the UID");

  const otherFile = parse("- [ ] Ship landing page [due:: 2026-07-02]", "Other.md").tasks[0];
  assert.notEqual(createUid(otherFile), createUid(before), "same title in another note is a different event");

  // Two identical titles in one note stay distinct.
  const twins = parse("- [ ] Review [due:: 2026-07-02]\n- [ ] Review [due:: 2026-07-02]").tasks;
  assert.notEqual(createUid(twins[0]), createUid(twins[1]));

  // An explicit id survives a rename of both the note and the task text.
  const idA = parse("- [ ] Ship it [due:: 2026-07-02] [id:: launch-2026]").tasks[0];
  const idB = parse("- [ ] Ship the thing [due:: 2026-08-02] [id:: launch-2026]", "Renamed.md").tasks[0];
  assert.equal(createUid(idA), createUid(idB), "an explicit id outranks path, title, and date");

  // A block id survives edits within the note.
  const blockA = parse("- [ ] Ship it [due:: 2026-07-02] ^abc123").tasks[0];
  const blockB = parse("intro\n\n- [ ] Ship it later [due:: 2026-07-09] ^abc123").tasks[0];
  assert.equal(createUid(blockA), createUid(blockB), "a block id is a stable identity");

  assert.match(createUid(before), /^tcb-[0-9a-f]{16}@task-calendar-bridge$/, "UID is an opaque 64-bit token");
}

// --- UID corpus: the values every existing calendar already contains ---------

{
  // Identity is derived from the CLEANED TITLE, so any change to title cleaning
  // silently re-identifies events — a duplicate in every calendar anyone has
  // imported, and no way to notice before the support mail arrives. These are
  // the actual UIDs 1.2.0 ships. Changing one is a breaking change that belongs
  // in the release notes; changing one by accident is the thing to prevent.
  const corpus = [
    ["- [ ] Ship landing page [due:: 2026-07-02]", "Projects/Alpha.md", "tcb-32cebc1684bdb214@task-calendar-bridge"],
    ["- [ ] Réunion [due:: 2026-07-02] #café", "Projects/Alpha.md", "tcb-d9c989f48343ee64@task-calendar-bridge"],
    ["- [ ] 会議 [due:: 2026-07-02] #仕事", "Projects/Alpha.md", "tcb-9799e85f04e01a55@task-calendar-bridge"],
    ["- [ ] Gym #health 🎉 [due:: 2026-07-02]", "Projects/Alpha.md", "tcb-b11e111551647e7b@task-calendar-bridge"],
    ["- [ ] Fix #123 in [[Design#Colours]] [due:: 2026-07-02] #work", "Projects/Alpha.md", "tcb-9eb25647f9fd855b@task-calendar-bridge"],
    ["- [ ] Standup [due:: 2026-07-02] ^block-1", "Daily/2026-07-02.md", "tcb-0eb748c72c99362d@task-calendar-bridge"],
    ["- [ ] Rent [due:: 2026-07-02] [id:: rent-2026-07]", "Home.md", "tcb-836a3ccb559f8ea3@task-calendar-bridge"],
  ];

  const actual = corpus.map(([markdown, file]) => createUid(parse(markdown, file, PRO).tasks[0]));
  const expected = corpus.map((entry) => entry[2]);
  if (process.env.TCB_PRINT_UIDS) {
    for (let i = 0; i < corpus.length; i++) console.log(`${JSON.stringify(corpus[i][0])} -> ${actual[i]}`);
  }
  assert.deepEqual(
    actual,
    expected,
    "A UID changed. Every calendar already importing these events will gain a duplicate and orphan the old one.\n" +
      "If that is intended, update this corpus AND say so in the release notes — see the 1.2.0 entry for the wording.\n" +
      "Re-run with TCB_PRINT_UIDS=1 to print the new values."
  );
}

// --- Parser coverage ---------------------------------------------------------

{
  // Code fences are documentation, not commitments.
  const fenced = parse("```markdown\n- [ ] Example task [due:: 2026-07-02]\n```\n- [ ] Real task [due:: 2026-07-03]");
  assert.deepEqual(fenced.tasks.map((t) => t.title), ["Real task"]);

  // Callouts, blockquotes, and numbered lists are real tasks.
  const quoted = parse("> [!todo]\n> - [ ] Callout task [due:: 2026-07-02]\n1. [ ] Numbered task [due:: 2026-07-03]\n1) [ ] Paren task [due:: 2026-07-04]");
  assert.deepEqual(quoted.tasks.map((t) => t.title), ["Callout task", "Numbered task", "Paren task"]);

  // Custom checkbox states.
  const states = parse("- [/] In progress [due:: 2026-07-02]\n- [-] Cancelled [due:: 2026-07-03]\n- [>] Forwarded [due:: 2026-07-04]", "s.md", PRO);
  assert.deepEqual(states.tasks.map((t) => t.status), ["in-progress", "cancelled", "todo"]);

  // Tasks-plugin emoji vocabulary.
  const emoji = parse("- [ ] Weekly sync ⏳ 2026-07-06 📅 2026-07-08 ⏫ 🔁 every week on Monday", "e.md", PRO).tasks[0];
  assert.equal(emoji.title, "Weekly sync", "no emoji or metadata may leak into the calendar summary");
  assert.equal(emoji.date, "2026-07-06", "scheduled date places the event");
  assert.equal(emoji.dueDate, "2026-07-08", "due date is kept as the deadline");
  assert.equal(emoji.priority, 2);
  assert.equal(emoji.recurrence.rrule, "FREQ=WEEKLY;BYDAY=MO");

  // Alternate due emoji.
  assert.equal(parse("- [ ] Alt 📆 2026-07-02").tasks[0].date, "2026-07-02");
  assert.equal(parse("- [ ] Alt 🗓 2026-07-02").tasks[0].date, "2026-07-02");

  // Prose after the date is not eaten.
  assert.equal(parse("- [ ] Call Alice 📅 2026-07-02 about the contract").tasks[0].title, "Call Alice about the contract");

  // The tag regex must not eat issue numbers or headings inside a wikilink.
  const tricky = parse("- [ ] Fix #123 in [[Design#Colours]] [due:: 2026-07-02] #work").tasks[0];
  assert.equal(tricky.title, "Fix #123 in Design#Colours");
  assert.deepEqual(tricky.tags, ["work"]);

  // Multi-word bare fields keep every word.
  assert.equal(parse("- [ ] Task due:: 2026-07-02 duration:: 1 hour").tasks[0].durationMinutes, 60);
  assert.equal(parse("- [ ] Task [due:: 2026-07-02] [duration:: 1h30m]").tasks[0].durationMinutes, 90);
  assert.equal(parse("- [ ] Task [due:: 2026-07-02] [duration:: soon]").tasks[0].durationMinutes, undefined);

  // A free-text field stops at ANY emoji, not only the Tasks vocabulary. Before
  // these patterns carried the u flag they matched lone surrogates and stopped
  // at whichever emoji happened to share a lead surrogate with ours; fixing the
  // flag without widening the class would have let a decorative emoji run into
  // the value and break the rule it belongs to.
  const celebration = parse("- [ ] Ship it [due:: 2026-07-02] [repeat:: every week] 🎉 party", "r.md", PRO).tasks[0];
  assert.equal(celebration.recurrence.rrule, "FREQ=WEEKLY");
  const bareRepeat = parse("- [ ] Ship it 📅 2026-07-02 🔁 every week 🎉", "r.md", PRO).tasks[0];
  assert.equal(bareRepeat.recurrence.rrule, "FREQ=WEEKLY", "a decorative emoji must not swallow the repeat rule");
  assert.equal(bareRepeat.recurrence.source, "every week", "nor end up quoted back at the user as part of it");

  // Dataview date links.
  assert.equal(parse("- [ ] Linked [due:: [[2026-07-02]]]").tasks[0].date, "2026-07-02");

  // Flexible time forms.
  assert.equal(parse("- [ ] Task [due:: 2026-07-02] [start:: 9:30]").tasks[0].startTime, "09:30");
  assert.equal(parse("- [ ] Task [due:: 2026-07-02] [start:: 09:30:00]").tasks[0].startTime, "09:30");

  // Markdown formatting in titles is rendered as text.
  assert.equal(parse("- [ ] **Bold** and `code` and [link](https://x.dev) [due:: 2026-07-02]").tasks[0].title, "Bold and code and link");
}

// --- Validation --------------------------------------------------------------

{
  assert.equal(isValidDate("2026-02-29"), false, "2026 is not a leap year");
  assert.equal(isValidDate("2024-02-29"), true);
  assert.equal(isValidDate("2026-99-99"), false);
  assert.equal(normalizeTime("29:75"), undefined);

  // A bad *placement* date removes the task: there is nowhere to put it.
  const bad = parse("- [ ] Broken [due:: 2026-99-99]");
  assert.equal(bad.tasks.length, 0);
  assert.equal(bad.skipped[0].reason, "invalid-date");

  // A bad *decoration* drops that field only. 1.0.4 exported these tasks and an
  // early 1.1.0 draft deleted them outright, which is a worse regression than
  // the bug it was fixing.
  const badTime = parse("- [ ] Meeting [due:: 2026-07-02] [start:: 29:75]");
  assert.equal(badTime.tasks.length, 1, "an unusable start time must not delete a task with a valid date");
  assert.equal(badTime.tasks[0].startTime, undefined);
  assert.equal(badTime.skipped[0].reason, "invalid-time");

  const badRange = parse("- [ ] Backwards [due:: 2026-07-05] [end:: 2026-07-01]");
  assert.equal(badRange.tasks.length, 1);
  assert.equal(badRange.tasks[0].endDate, undefined);
  assert.equal(badRange.skipped[0].reason, "invalid-range");

  assert.equal(parse("- [ ] Odd [due:: 2026-07-02] [duration:: soon]").tasks.length, 1);
  assert.equal(isValidDate("0026-08-01"), false, "Date.UTC would remap a two-digit year to 1926");
}

// --- Regressions against 1.0.4 -----------------------------------------------

{
  // Bare fields with trailing content: every one of these exported in 1.0.4.
  const cases = [
    ["- [ ] Draft proposal due:: 2026-08-02 #work", "Draft proposal", "2026-08-02"],
    ["- [ ] Draft due:: 2026-08-02 ^abc123", "Draft", "2026-08-02"],
    ["- [ ] Ship the thing due:: 2026-08-02 review with Sam", "Ship the thing review with Sam", "2026-08-02"],
    ["- [ ] Plan scheduled:: 2026-08-02 **important**", "Plan important", "2026-08-02"],
  ];
  for (const [input, title, date] of cases) {
    const { tasks } = parse(input);
    assert.equal(tasks.length, 1, `must still export: ${input}`);
    assert.equal(tasks[0].date, date, `wrong date for: ${input}`);
    assert.equal(tasks[0].title, title, `wrong title for: ${input}`);
  }

  // A trailing tag must not corrupt the identity or lose a decoration.
  assert.equal(parse("- [ ] A [due:: 2026-08-02] id:: launch-2026 #work").tasks[0].stableId, "launch-2026");
  assert.equal(parse("- [ ] A [due:: 2026-08-02] duration:: 45m").tasks[0].durationMinutes, 45);
  assert.equal(parse("- [ ] A [due:: 2026-08-02] priority:: high").tasks[0].priority, 2);
}

// --- Same title on different dates -------------------------------------------

{
  // Writing the same task on successive days is the commonest hand-rolled
  // recurrence there is. Keying the occurrence counter on title+date collapsed
  // all of them onto one UID and silently dropped every event but the first.
  const { tasks } = parse("- [ ] Standup 📅 2026-08-03\n- [ ] Standup 📅 2026-08-04\n- [ ] Standup 📅 2026-08-05");
  assert.equal(tasks.length, 3);
  assert.equal(new Set(tasks.map(createUid)).size, 3, "three standups must be three events");

  const result = generateIcsCalendar(tasks, ICS_OPTIONS, new Date("2026-01-01T00:00:00Z"));
  assert.equal(result.eventCount, 3);
  assert.equal(result.duplicateIds.length, 0);
}

// --- Code fences --------------------------------------------------------------

{
  // A closing fence must match its opener's character and length.
  const nested = parse("````\n```\n````\n- [ ] Real task 📅 2026-08-03");
  assert.deepEqual(nested.tasks.map((t) => t.title), ["Real task"], "a ``` line must not close a ```` block");

  const crossType = parse("```sh\n# usage\n~~~\n- [ ] doc example 📅 2026-08-03\n```");
  assert.deepEqual(crossType.tasks.map((t) => t.title), [], "a ~~~ line must not close a ``` block");

  // An unterminated fence must not swallow the rest of the note.
  const unclosed = parse("```js\nconst x = 1;\n\n- [ ] Real task 📅 2026-08-03");
  assert.deepEqual(unclosed.tasks.map((t) => t.title), ["Real task"], "an unclosed fence must not hide every task below it");

  const closed = parse("```js\n- [ ] doc task 📅 2026-08-03\n```\n- [ ] real 📅 2026-08-04");
  assert.deepEqual(closed.tasks.map((t) => t.title), ["real"]);

  // A fence belongs to its blockquote. Flattening the quote markers first let a
  // callout's fence be closed by an unrelated top-level fence, deleting every
  // real task in between.
  const callout = parse("> [!note] Setup\n> ```bash\n> npm install\n\n- [ ] Ship the release 📅 2026-08-03\n\n```js\nconst x = 1;\n```");
  assert.deepEqual(callout.tasks.map((t) => t.title), ["Ship the release"], "a callout's fence must not reach outside the callout");

  // ...and a quoted ``` line inside a genuine code block must not close it.
  const quotedFence = parse("```markdown\n> [!tip] Example\n> ```\n> - [ ] example task 📅 2026-08-05\n> ```\n```");
  assert.deepEqual(quotedFence.tasks.map((t) => t.title), [], "a quoted fence line must not close a top-level block");
}

// --- 12-hour clock times ------------------------------------------------------

{
  // The bare capture used to stop at the space, so `7:00 pm` validated as 7:00
  // and a dinner was exported twelve hours early with nothing reported.
  assert.equal(normalizeTime("7:00 pm"), "19:00");
  assert.equal(normalizeTime("7pm"), "19:00");
  assert.equal(normalizeTime("12:00 am"), "00:00");
  assert.equal(normalizeTime("12:30 pm"), "12:30");
  assert.equal(normalizeTime("13:00 pm"), undefined);

  for (const input of ["- [ ] Dinner due:: 2026-08-03 start:: 7:00 pm", "- [ ] Dinner [due:: 2026-08-03] [start:: 7:00 pm]"]) {
    const task = parse(input).tasks[0];
    assert.equal(task.startTime, "19:00", `wrong time for: ${input}`);
    assert.equal(task.title, "Dinner", `meridiem leaked into the title for: ${input}`);
  }
}

// --- Trailing notes on a field value ------------------------------------------

{
  // A tag, block id, or parenthetical after a value is a comment on the task,
  // not part of the value. Treating it as part of the value dropped durations
  // and downgraded Pro repeating events to one-off ones, silently.
  assert.equal(parse("- [ ] T [due:: 2026-08-02] duration:: 45m (about an hour)").tasks[0].durationMinutes, 45);
  assert.equal(parse("- [ ] T [due:: 2026-08-02] duration:: 45m #work").tasks[0].durationMinutes, 45);
  assert.equal(parse("- [ ] Sync [due:: 2026-08-03] 🔁 every week on Monday #work", "r.md", PRO).tasks[0].recurrence.rrule, "FREQ=WEEKLY;BYDAY=MO");
  assert.equal(parse("- [ ] Sync [due:: 2026-08-03] 🔁 every week on Monday ^abc1", "r.md", PRO).tasks[0].recurrence.rrule, "FREQ=WEEKLY;BYDAY=MO");

  // ...but the ordinary English word "am" after a date is not a meridiem.
  const amWord = parse("- [ ] Check due:: 2026-08-02 am I ready");
  assert.equal(amWord.tasks.length, 1, "the word 'am' must not be read as a meridiem and drop the task");
  assert.equal(amWord.tasks[0].date, "2026-08-02");
}

// --- Hostile field values ------------------------------------------------------

{
  // Object-prototype keys used to resolve to functions and were written
  // straight into the file: `RRULE:FREQ=function Object() { [native code] }`.
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const priority = parse(`- [ ] T [due:: 2026-08-02] [priority:: ${key}]`).tasks[0];
    assert.equal(priority.priority, undefined, `priority:: ${key} must not resolve to a prototype member`);

    const repeat = parse(`- [ ] T [due:: 2026-08-02] [repeat:: every ${key}]`, "r.md", PRO).tasks[0];
    assert.equal(repeat.recurrence, undefined, `repeat:: every ${key} must not resolve to a prototype member`);
  }
  const out = ics(parse("- [ ] T [due:: 2026-08-02] [repeat:: every constructor]", "r.md", PRO).tasks);
  assert.ok(!out.includes("native code"), "no prototype member may reach the calendar file");

  // Control characters are illegal in an ICS value and made the file unimportable.
  const bel = String.fromCharCode(7);
  const controlled = ics(parse(`- [ ] Bad${bel}title [due:: 2026-08-02]`).tasks);
  // Written as escapes, not as raw bytes. Embedding a literal NUL here made
  // grep and ripgrep classify this whole file as binary and skip it, so a
  // repo-wide search for an assertion silently missed the largest test file.
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(controlled), "control characters must never reach the file");
  assert.ok(controlled.includes("SUMMARY:Badtitle"));
}

// --- Fatal losses versus ignored fields ---------------------------------------

{
  // "N tasks could not be exported" must mean exactly that.
  const lost = parse("- [ ] undated task").skipped[0];
  assert.equal(lost.fatal, true);

  const warned = parse("- [ ] Meeting [due:: 2026-08-02] [start:: nonsense]").skipped[0];
  assert.equal(warned.fatal, false, "a dropped field is a warning, not a lost task");
  assert.equal(parse("- [ ] Meeting [due:: 2026-08-02] [start:: nonsense]").tasks.length, 1);
}

// --- Identity is not disturbed by filtering -----------------------------------

{
  // Ticking off one of three same-titled tasks must not renumber the others.
  const before = parse("- [ ] Standup 📅 2026-08-03\n- [ ] Standup 📅 2026-08-04\n- [ ] Standup 📅 2026-08-05").tasks;
  const after = parse("- [x] Standup 📅 2026-08-03\n- [ ] Standup 📅 2026-08-04\n- [ ] Standup 📅 2026-08-05").tasks;
  assert.equal(after.length, 2);
  assert.equal(createUid(after[0]), createUid(before[1]), "completing a task must not rewrite its neighbours' UIDs");
  assert.equal(createUid(after[1]), createUid(before[2]));
}

// --- Dataview link forms ------------------------------------------------------

{
  assert.equal(parse("- [ ] A [due:: [[dates/2026-08-02|Aug 2]]]").tasks[0].date, "2026-08-02");
  assert.equal(parse("- [ ] A [due:: [[Daily/2026-08-02]]]").tasks[0].date, "2026-08-02");

  // A parenthetical must not truncate a repeat rule.
  const parenthetical = parse("- [ ] Sync [due:: 2026-08-03] repeat:: every 2 weeks on Monday (biweekly)", "p.md", PRO).tasks[0];
  assert.equal(parenthetical.recurrence.rrule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
}

// --- Repeat rules must agree with the task's date -----------------------------

{
  // FREQ=MONTHLY;BYMONTHDAY=15 with DTSTART on the 3rd means different things in
  // different clients, so it is reported rather than shipped.
  const mismatch = parse("- [ ] Pay rent [due:: 2026-08-03] [repeat:: every month on the 15th]", "m.md", PRO);
  assert.equal(mismatch.tasks[0].recurrence, undefined);
  assert.equal(mismatch.skipped[0].reason, "unsupported-recurrence");

  const aligned = parse("- [ ] Pay rent [due:: 2026-08-15] [repeat:: every month on the 15th]", "m.md", PRO);
  assert.equal(aligned.tasks[0].recurrence.rrule, "FREQ=MONTHLY;BYMONTHDAY=15");

  // 2026-08-03 is a Monday.
  assert.ok(parse("- [ ] Sync [due:: 2026-08-03] [repeat:: every week on Monday]", "m.md", PRO).tasks[0].recurrence);
  assert.equal(parse("- [ ] Sync [due:: 2026-08-04] [repeat:: every week on Monday]", "m.md", PRO).tasks[0].recurrence, undefined);

  // "on the last" is BYMONTHDAY=-1, which a `wanted > 0` guard skipped entirely.
  assert.equal(parse("- [ ] Rent [due:: 2026-08-03] [repeat:: every month on the last]", "m.md", PRO).tasks[0].recurrence, undefined);
  assert.ok(parse("- [ ] Rent [due:: 2026-08-31] [repeat:: every month on the last]", "m.md", PRO).tasks[0].recurrence);
  assert.ok(parse("- [ ] Rent [due:: 2026-02-28] [repeat:: every month on the last]", "m.md", PRO).tasks[0].recurrence);

  // A repeat rule that does nothing because the feature is off must say so.
  const off = parse("- [ ] Sync [due:: 2026-08-03] [repeat:: every week on Monday]", "m.md", FREE);
  assert.equal(off.tasks.length, 1);
  assert.equal(off.skipped[0].reason, "repeat-not-enabled");
}

// --- ICS output --------------------------------------------------------------

{
  const { tasks } = parse(
    `- [ ] Ship landing page 📅 2026-07-02 #client
- [ ] Call Alice [due:: 2026-07-04] [start:: 09:30] [duration:: 45m] [reminder:: 30m]`,
    "Projects/Alpha.md",
    PRO
  );
  const out = ics(tasks);

  assert.ok(out.startsWith("BEGIN:VCALENDAR"));
  assert.ok(out.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!out.includes("METHOD:"), "METHOD declares an iTIP message and needs an ORGANIZER we do not have");
  assert.ok(out.includes("DTSTART;VALUE=DATE:20260702"));
  assert.ok(out.includes("DTEND;VALUE=DATE:20260703"), "all-day DTEND is exclusive");
  assert.ok(out.includes("TRANSP:TRANSPARENT"), "an all-day task must not mark the whole day busy");
  assert.ok(out.includes("CATEGORIES:client"));
  assert.ok(out.includes("DTSTART:20260704T093000"));
  assert.ok(out.includes("DURATION:PT45M"));
  assert.ok(out.includes("TRIGGER:-PT30M"));
  assert.ok(out.includes("URL:obsidian://open?vault=My%20Vault&file=Projects%2FAlpha"));
  assert.ok(!out.includes("%23L"), "the dead #L<line> anchor must not come back");

  // Escaping had NO test at all: every one of these rules could be deleted
  // individually and the whole suite stayed green, while the generated file
  // became unparseable for every event rather than in some edge case.
  assert.equal(escapeIcsText("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
  const escaped = ics(parse("- [ ] Call Bob, then Alice; urgent \\ now [due:: 2026-07-02]").tasks, { calendarName: "My; Cal, Name" });
  assert.ok(escaped.includes("SUMMARY:Call Bob\\, then Alice\\; urgent \\\\ now"), "TEXT values escape , ; and \\");
  assert.ok(/DESCRIPTION:Source: Projects\/Alpha.md \(line 1\)\\nobsidian:/.test(escaped), "a newline inside DESCRIPTION must be escaped, not emitted raw");
  assert.ok(escaped.includes("X-WR-CALNAME:My\\; Cal\\, Name"), "calendar-level TEXT is escaped too");

  // Folding was only ever tested on foldIcsLine in isolation, so removing the
  // fold pass from the generator left every assertion passing while shipping
  // content lines well over the 75-octet limit.
  const wide = ics(
    parse("- [ ] Quarterly board meeting preparation and agenda circulation for the leadership team [due:: 2026-07-02] #client", "Projects/A very long note name indeed.md").tasks
  );
  for (const line of wide.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `unfolded line (${Buffer.byteLength(line, "utf8")} octets): ${line}`);
  }
  assert.ok(wide.split("\r\n").some((line) => line.startsWith(" ")), "a long line must actually have been folded");

  // STATUS:COMPLETED is a VTODO value and made the file invalid.
  const done = ics(parse("- [x] Finished [due:: 2026-07-02]", "d.md", PRO).tasks);
  assert.ok(!done.includes("STATUS:COMPLETED"));
  assert.ok(done.includes("STATUS:CONFIRMED"));
  assert.ok(done.includes("X-OBSIDIAN-TASK-COMPLETED:TRUE"));
  assert.ok(done.includes("CATEGORIES:Completed"));

  const cancelled = ics(parse("- [-] Dropped [due:: 2026-07-02]", "c.md", PRO).tasks);
  assert.ok(cancelled.includes("STATUS:CANCELLED"));

  // Priority.
  assert.ok(ics(parse("- [ ] Urgent 🔺 [due:: 2026-07-02]").tasks).includes("PRIORITY:1"));

  // Recurrence.
  assert.ok(ics(parse("- [ ] Standup [due:: 2026-07-02] [repeat:: every weekday]", "r.md", PRO).tasks).includes("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"));

  // Free tier drops the rule but keeps the event.
  assert.ok(!ics(parse("- [ ] Standup [due:: 2026-07-02] [repeat:: every weekday]", "r.md", FREE).tasks).includes("RRULE"));

  // An all-day alarm must not fire at 23:30 the night before.
  const allDayAlarm = ics(parse("- [ ] Renew passport [due:: 2026-07-02] [reminder:: 30m]", "a.md", PRO).tasks);
  assert.ok(allDayAlarm.includes("TRIGGER:PT510M"), "09:00 minus 30 minutes = 08:30 on the day");

  // Free tier drops the alarm and says so, rather than emitting one silently.
  const freeAlarm = parse("- [ ] Renew passport [due:: 2026-07-02] [reminder:: 30m]", "a.md", FREE);
  assert.ok(!ics(freeAlarm.tasks).includes("BEGIN:VALARM"));
  assert.equal(freeAlarm.skipped.filter((s) => s.reason === "reminder-not-enabled").length, 1);

  // A multi-day timed task keeps its end date instead of silently losing it.
  const spanning = ics(parse("- [ ] Conference [due:: 2026-07-02] [end:: 2026-07-04] [start:: 09:00] [duration:: 1h]").tasks);
  assert.ok(spanning.includes("DTEND:20260704T100000"));

  // Source links off: the vault name, the note paths, and the line numbers all
  // leave the file, because a published calendar is a public document.
  const unlinked = ics(parse("- [ ] Private matter [due:: 2026-07-02] #health").tasks, { linkToSource: false });
  assert.ok(!unlinked.includes("obsidian://"), "no link back to the vault");
  assert.ok(!unlinked.includes("My%20Vault"), "the vault name must not survive anywhere");
  assert.ok(!unlinked.includes("Projects/Alpha.md"), "nor the note path");
  assert.ok(!unlinked.includes("URL:"));
  assert.ok(unlinked.includes("SUMMARY:Private matter"), "the event itself is unchanged");
  // A due date and a repeat rule still belong in the description when there is one.
  const unlinkedDue = ics(parse("- [ ] Task ⏳ 2026-07-02 📅 2026-07-09").tasks, { linkToSource: false });
  assert.ok(unlinkedDue.includes("DESCRIPTION:Due: 2026-07-09"));
  assert.ok(!unlinkedDue.includes("Source:"));

  // Tags off.
  assert.ok(!ics(parse("- [ ] Tagged [due:: 2026-07-02] #client").tasks, { exportTags: false }).includes("CATEGORIES"));

  // Duplicate explicit ids are reported, not written twice.
  const dupes = generateIcsCalendar(
    parse("- [ ] One [due:: 2026-07-02] [id:: same]\n- [ ] Two [due:: 2026-07-03] [id:: same]").tasks,
    ICS_OPTIONS,
    new Date("2026-01-01T00:00:00Z")
  );
  assert.equal(dupes.eventCount, 1);
  assert.equal(dupes.duplicateIds.length, 1);
}

// --- Time zones --------------------------------------------------------------

{
  assert.equal(formatZonedDateTimeAsUtc("2026-07-04", "09:30", "America/New_York"), "20260704T133000Z", "EDT is UTC-4");
  assert.equal(formatZonedDateTimeAsUtc("2026-01-04", "09:30", "America/New_York"), "20260104T143000Z", "EST is UTC-5");
  assert.equal(formatZonedDateTimeAsUtc("2026-07-04", "09:30", "UTC"), "20260704T093000Z");
  assert.equal(formatZonedDateTimeAsUtc("2026-07-04", "09:30", "Not/AZone"), undefined);

  // A fixed zone is expressed the standard way: wall time plus TZID, with a
  // VTIMEZONE defining the zone. 1.1.0 emitted a resolved UTC instant instead,
  // which is correct for one event but silently wrong for a repeating one.
  const zoned = ics(parse("- [ ] Call [due:: 2026-07-04] [start:: 09:30]").tasks, { timeMode: "zoned", timeZone: "America/New_York" });
  assert.ok(zoned.includes("DTSTART;TZID=America/New_York:20260704T093000"), "a zoned event carries TZID and wall time");
  assert.ok(zoned.includes("BEGIN:VTIMEZONE"), "the zone it names must be defined in the file");
  assert.ok(zoned.includes("TZID:America/New_York"));
  assert.ok(zoned.includes("X-WR-TIMEZONE:America/New_York"));
  assert.ok(!zoned.includes("DTSTART:20260704T133000Z"));

  // An unknown zone has no VTIMEZONE to offer, so it falls back rather than
  // naming a TZID the file never defines.
  const broken = ics(parse("- [ ] Call [due:: 2026-07-04] [start:: 09:30]").tasks, { timeMode: "zoned", timeZone: "Not/AZone" });
  assert.ok(broken.includes("DTSTART:20260704T093000"));
  assert.ok(!broken.includes("BEGIN:VTIMEZONE"));
  assert.ok(!broken.includes("TZID="));

  // An all-day task has no clock time to place, so it must never drag a
  // VTIMEZONE into the file or acquire a TZID.
  const allDayZoned = ics(parse("- [ ] Deadline [due:: 2026-07-04]").tasks, { timeMode: "zoned", timeZone: "America/New_York" });
  assert.ok(allDayZoned.includes("DTSTART;VALUE=DATE:20260704"));
  assert.ok(!allDayZoned.includes("BEGIN:VTIMEZONE"));

  // Spring-forward gaps must resolve FORWARD. Testing only a zone west of UTC
  // hid the bug: east of UTC the naive probe read the post-transition offset and
  // a gap time landed an hour EARLIER, so a later clock time sorted first.
  // A nonexistent wall time shifts forward by the length of the gap, the same
  // convention Temporal's "compatible" mode and dateutil use.
  const gaps = [
    ["America/New_York", "2026-03-08", "01:30", "02:30", "20260308T073000Z"], // -> 03:30 EDT
    ["Europe/London", "2026-03-29", "00:30", "01:30", "20260329T013000Z"], // -> 02:30 BST
    ["Europe/Madrid", "2026-03-29", "01:30", "02:30", "20260329T013000Z"], // -> 03:30 CEST
    ["Australia/Sydney", "2026-10-04", "01:30", "02:30", "20261003T163000Z"], // -> 03:30 AEDT
  ];
  for (const [zone, date, valid, gap, expected] of gaps) {
    const resolved = formatZonedDateTimeAsUtc(date, gap, zone);
    assert.equal(resolved, expected, `gap time in ${zone}`);
    // The bug this replaced resolved gap times BACKWARD, so a later clock time
    // landed before the hour preceding it. That must never happen again.
    assert.ok(resolved > formatZonedDateTimeAsUtc(date, valid, zone), `${zone} gap time resolved backwards`);
  }

  // Outside the one-hour gap, a later wall time always means a later instant.
  for (const [zone, date] of [["America/New_York", "2026-03-08"], ["Europe/London", "2026-03-29"], ["Australia/Sydney", "2026-10-04"]]) {
    let previous = "";
    for (let minutes = 4 * 60; minutes < 24 * 60; minutes += 15) {
      const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      const stamp = formatZonedDateTimeAsUtc(date, time, zone);
      assert.ok(stamp >= previous, `${zone} ${time} went backwards`);
      previous = stamp;
    }
  }

  // An ambiguous fall-back time happens twice; take the earlier instant, the
  // same convention in every zone regardless of which side of UTC it sits.
  assert.equal(formatZonedDateTimeAsUtc("2026-11-01", "01:30", "America/New_York"), "20261101T053000Z");
  assert.equal(formatZonedDateTimeAsUtc("2026-10-25", "01:30", "Europe/London"), "20261025T003000Z");
  assert.equal(formatZonedDateTimeAsUtc("2026-04-05", "02:30", "Australia/Sydney"), "20260404T153000Z");

  // Half-hour and 45-minute offsets.
  assert.equal(formatZonedDateTimeAsUtc("2026-07-04", "09:30", "Asia/Kolkata"), "20260704T040000Z");
  // Chatham is +12:45 in the southern winter.
  assert.equal(formatZonedDateTimeAsUtc("2026-07-04", "09:30", "Pacific/Chatham"), "20260703T204500Z");

  // A repeating event pinned to a UTC instant drifts an hour when DST flips, so
  // recurrence stays on wall-clock time — but in fixed-zone mode that wall time
  // must be bound to the zone, not left floating for the viewer to guess at.
  const recurring = ics(parse("- [ ] Standup [due:: 2026-08-03] [start:: 09:00] [repeat:: every week on Monday]", "r.md", PRO).tasks, {
    timeMode: "zoned",
    timeZone: "America/New_York",
  });
  assert.ok(recurring.includes("DTSTART;TZID=America/New_York:20260803T090000"), "a recurring zoned event is bound to its zone");
  assert.ok(!recurring.includes("DTSTART:20260803T130000Z"), "and is never pinned to a UTC instant");
  assert.ok(recurring.includes("BEGIN:VTIMEZONE"));

  // Local wall time means exactly that: no TZID, no VTIMEZONE, no zone hint.
  const floating = ics(parse("- [ ] Call [due:: 2026-07-04] [start:: 09:30]").tasks, { timeMode: "floating", timeZone: "America/New_York" });
  assert.ok(floating.includes("DTSTART:20260704T093000"));
  assert.ok(!floating.includes("BEGIN:VTIMEZONE"));
  assert.ok(!floating.includes("X-WR-TIMEZONE"));
}

// --- VTIMEZONE generation -----------------------------------------------------

{
  // Northern DST pair. DTSTART inside a VTIMEZONE component is wall time in the
  // offset that was in force BEFORE the change, which is what makes the RRULE
  // land on the right instant every year.
  const ny = buildVtimezone("America/New_York", 2026);
  assert.deepEqual(ny, [
    "BEGIN:VTIMEZONE",
    "TZID:America/New_York",
    "BEGIN:DAYLIGHT",
    "DTSTART:20250309T020000",
    "TZOFFSETFROM:-0500",
    "TZOFFSETTO:-0400",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "DTSTART:20251102T020000",
    "TZOFFSETFROM:-0400",
    "TZOFFSETTO:-0500",
    "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
  ]);

  // "Last Sunday" has to be expressed as -1SU, not 5SU, or it breaks in the
  // years where the month has only four of that weekday.
  const madrid = (buildVtimezone("Europe/Madrid", 2026) ?? []).join("\n");
  assert.ok(madrid.includes("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU"), "Madrid springs forward on the last Sunday in March");
  assert.ok(madrid.includes("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU"));

  // Southern hemisphere: the STANDARD change comes first in the year, so the
  // components must be labelled by which way the offset moves, not by order.
  const sydney = (buildVtimezone("Australia/Sydney", 2026) ?? []).join("\n");
  assert.ok(sydney.includes("BEGIN:STANDARD\nDTSTART:20250406T030000\nTZOFFSETFROM:+1100\nTZOFFSETTO:+1000"));
  assert.ok(sydney.includes("BEGIN:DAYLIGHT\nDTSTART:20251005T020000\nTZOFFSETFROM:+1000\nTZOFFSETTO:+1100"));

  // Sub-hour offsets, and a zone whose DST step is 30 minutes rather than 60.
  const lordHowe = (buildVtimezone("Australia/Lord_Howe", 2026) ?? []).join("\n");
  assert.ok(lordHowe.includes("TZOFFSETFROM:+1100\nTZOFFSETTO:+1030"), "Lord Howe shifts by 30 minutes");
  assert.ok(lordHowe.includes("TZOFFSETFROM:+1030\nTZOFFSETTO:+1100"));
  const chatham = (buildVtimezone("Pacific/Chatham", 2026) ?? []).join("\n");
  assert.ok(chatham.includes("TZOFFSETTO:+1245"), "Chatham is a 45-minute zone");
  assert.ok(chatham.includes("TZOFFSETTO:+1345"));

  // A zone that never changes offset gets one STANDARD component and no rule.
  assert.deepEqual(buildVtimezone("Asia/Kolkata", 2026), [
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Kolkata",
    "BEGIN:STANDARD",
    "DTSTART:20250101T000000",
    "TZOFFSETFROM:+0530",
    "TZOFFSETTO:+0530",
    "END:STANDARD",
    "END:VTIMEZONE",
  ]);
  assert.ok((buildVtimezone("Asia/Kathmandu", 2026) ?? []).join("\n").includes("TZOFFSETTO:+0545"));

  assert.equal(buildVtimezone("Not/AZone", 2026), undefined);
  assert.equal(buildVtimezone("", 2026), undefined);

  // A yearly rule inferred from one year is a guess until it is checked against
  // the next one. Morocco's transitions follow Ramadan, so "the third Sunday in
  // March" is right in 2026 and wrong in 2027 — the generator must decline
  // rather than ship a rule that puts events an hour out for a whole season.
  assert.equal(buildVtimezone("Africa/Casablanca", 2026), undefined, "an irregular zone must fall back, not guess");

  // Every observance must start BEFORE the year the calendar is about, or an
  // event in January refers to a zone with no observance covering it.
  for (const zone of ["America/New_York", "Europe/Madrid", "Australia/Sydney", "Pacific/Chatham", "Asia/Kolkata"]) {
    for (const line of buildVtimezone(zone, 2026) ?? []) {
      if (!line.startsWith("DTSTART:")) continue;
      assert.ok(Number(line.slice(8, 12)) < 2026, `${zone} observance starts inside the anchor year: ${line}`);
    }
  }
  const irregular = ics(parse("- [ ] Call [due:: 2026-07-04] [start:: 09:30]").tasks, { timeMode: "zoned", timeZone: "Africa/Casablanca" });
  assert.ok(!irregular.includes("BEGIN:VTIMEZONE"));
  assert.ok(!irregular.includes("TZID="));
  assert.ok(/DTSTART:\d{8}T\d{6}Z/.test(irregular), "and the event falls back to a resolved UTC instant");

  // Every component the generator emits must be structurally complete, or the
  // whole calendar file is rejected.
  for (const zone of ["America/New_York", "Europe/Madrid", "Australia/Sydney", "Australia/Lord_Howe", "Pacific/Chatham", "Asia/Kolkata", "UTC", "America/Sao_Paulo", "Europe/Dublin", "Antarctica/Troll"]) {
    const lines = buildVtimezone(zone, 2026);
    assert.ok(lines, `${zone} should be describable`);
    assert.equal(lines[0], "BEGIN:VTIMEZONE");
    assert.equal(lines[lines.length - 1], "END:VTIMEZONE");
    const opens = lines.filter((line) => line === "BEGIN:STANDARD" || line === "BEGIN:DAYLIGHT").length;
    const closes = lines.filter((line) => line === "END:STANDARD" || line === "END:DAYLIGHT").length;
    assert.equal(opens, closes, `${zone} has unbalanced sub-components`);
    assert.ok(opens >= 1, `${zone} needs at least one sub-component`);
    for (const line of lines) {
      if (line.startsWith("TZOFFSET")) assert.ok(/^TZOFFSET(FROM|TO):[+-]\d{4}$/.test(line), `bad offset in ${zone}: ${line}`);
      if (line.startsWith("DTSTART")) assert.ok(/^DTSTART:\d{8}T\d{6}$/.test(line), `bad DTSTART in ${zone}: ${line}`);
    }
  }
}

// --- Performance guards -------------------------------------------------------

{
  // The bracket field pattern used to backtrack quadratically: a long line of
  // "[[a" froze Obsidian's main thread for seconds during export.
  const hostile = `- [ ] T [due:: ${"[[a".repeat(30000)} 📅 2026-08-03`;
  const started = Date.now();
  const hostileResult = parse(hostile, "N.md", PRO);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `parsing a pathological line took ${elapsed}ms`);
  assert.equal(hostileResult.skipped[0].reason, "line-too-long", "an over-long line is reported, not silently ignored");

  // The line above never reaches the field patterns at all — the length cap
  // rejects it first — so on its own it guards nothing. The real guard is a line
  // just UNDER the cap, which does run every pattern this section is about.
  const adversarial = `- [ ] T [due:: ${"[[a".repeat(600)} 📅 2026-08-03`;
  assert.ok(adversarial.length < 2000 + 10, "the fixture must stay under the line cap to be meaningful");
  const backtrackStart = Date.now();
  const backtracked = parse(adversarial, "N.md", PRO);
  const backtrackElapsed = Date.now() - backtrackStart;
  assert.equal(backtracked.tasks.length, 1, "an unterminated bracket run still parses");
  assert.ok(backtrackElapsed < 250, `a near-cap adversarial line took ${backtrackElapsed}ms`);

  // Title cleanup runs its own set of patterns over the same kind of input.
  const cleanupStart = Date.now();
  parse(`- [ ] ${"[due:: ".repeat(250)} 📅 2026-08-03`, "N.md", PRO);
  assert.ok(Date.now() - cleanupStart < 250, "title cleanup must not backtrack either");

  // A long but realistic task line still parses.
  const long = `- [ ] ${"word ".repeat(300)}[due:: 2026-08-03]`;
  assert.equal(parse(long).tasks.length, 1);

  // Durations longer than a year are typos, and PT<huge>M breaks calendar apps.
  assert.equal(parse("- [ ] T [due:: 2026-08-03] [duration:: 99999h]").tasks[0].durationMinutes, undefined);
  assert.equal(parse("- [ ] T [due:: 2026-08-03] [duration:: 1,5h]").tasks[0].durationMinutes, 90, "1,5h is 90 minutes, not 5h1m");
}

// --- The one value read from the local clock ---------------------------------

{
  // localToday decides the free tier's "upcoming" cutoff and takes an injectable
  // `now` precisely so it can be tested — and nothing ever called it. Built from
  // local components on both sides, so these hold in every time zone.
  assert.equal(localToday(new Date(2026, 7, 4, 23, 30)), "2026-08-04", "late evening is still today, not tomorrow in UTC");
  assert.equal(localToday(new Date(2026, 0, 1, 0, 0)), "2026-01-01");
  assert.equal(localToday(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
  assert.equal(localToday(new Date(2028, 1, 29, 12, 0)), "2028-02-29", "leap day");
  assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/);
}

// --- Free-tier selection -----------------------------------------------------

{
  const lines = [];
  for (let i = 1; i <= 40; i++) lines.push(`- [ ] Task ${i} [due:: 2026-${String(((i - 1) % 12) + 1).padStart(2, "0")}-15]`);
  const { tasks } = parse(lines.join("\n"));

  const chosen = selectUpcoming(tasks, 5, "2026-06-01");
  assert.equal(chosen.length, 5);
  assert.ok(chosen.every((t) => t.date >= "2026-06-01"), "the free tier exports upcoming tasks, not whichever came first");
  assert.deepEqual([...chosen].sort(compareTasks).map((t) => t.date), chosen.map((t) => t.date), "output is date-ordered");

  // When there is nothing upcoming, fall back to the most recent past tasks
  // rather than exporting an empty calendar.
  const pastOnly = selectUpcoming(tasks, 5, "2099-01-01");
  assert.equal(pastOnly.length, 5);
  assert.equal(new Set(pastOnly.map((t) => t.stableId)).size, 5, "the top-up branch must not repeat a task");

  // Every boundary: nothing upcoming, fewer than the limit, exactly the limit, more.
  for (const limit of [0, 1, 5, 21, 40, 100]) {
    const picked = selectUpcoming(tasks, limit, "2026-06-01");
    assert.equal(picked.length, Math.min(limit, tasks.length), `limit ${limit}`);
    assert.equal(new Set(picked.map((t) => t.stableId)).size, picked.length, `limit ${limit} produced a duplicate`);
  }

  assert.equal(FREE_TASK_LIMIT, 25);
}

// --- Recurrence translation --------------------------------------------------

{
  assert.equal(parseRecurrence("every day").rrule, "FREQ=DAILY");
  assert.equal(parseRecurrence("every 3 days").rrule, "FREQ=DAILY;INTERVAL=3");
  assert.equal(parseRecurrence("every week").rrule, "FREQ=WEEKLY");
  assert.equal(parseRecurrence("every 2 weeks on Monday, Friday").rrule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR");
  assert.equal(parseRecurrence("every Monday").rrule, "FREQ=WEEKLY;BYDAY=MO");
  assert.equal(parseRecurrence("every month on the 15th").rrule, "FREQ=MONTHLY;BYMONTHDAY=15");
  assert.equal(parseRecurrence("every month on the last").rrule, "FREQ=MONTHLY;BYMONTHDAY=-1");
  assert.equal(parseRecurrence("every year").rrule, "FREQ=YEARLY");
  assert.equal(parseRecurrence("every week when done").rrule, "FREQ=WEEKLY");
  assert.equal(parseRecurrence("every 2 months on the 40th"), undefined);

  // Ordinary English people actually write. Reporting these as untranslatable
  // and silently downgrading the event to a one-off was a trust leak in a
  // feature the user paid for.
  assert.equal(parseRecurrence("every fortnight").rrule, "FREQ=WEEKLY;INTERVAL=2");
  assert.equal(parseRecurrence("every other week").rrule, "FREQ=WEEKLY;INTERVAL=2");
  assert.equal(parseRecurrence("every other Friday").rrule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR");
  assert.equal(parseRecurrence("every Monday and Friday").rrule, "FREQ=WEEKLY;BYDAY=MO,FR");
  assert.equal(parseRecurrence("every Tuesdays").rrule, "FREQ=WEEKLY;BYDAY=TU");
  assert.equal(parseRecurrence("every week on weds").rrule, "FREQ=WEEKLY;BYDAY=WE");
  assert.equal(parseRecurrence("every month on the first Monday").rrule, "FREQ=MONTHLY;BYDAY=1MO");
  assert.equal(parseRecurrence("every month on the last Friday").rrule, "FREQ=MONTHLY;BYDAY=-1FR");
  assert.equal(parseRecurrence("every 2 months on the 3rd Tuesday").rrule, "FREQ=MONTHLY;INTERVAL=2;BYDAY=3TU");

  // A token this cannot read must reject the whole rule. Dropping it turned
  // "every week on Monday, Funday" into a Monday-only schedule — a rule that
  // means something different from what the user wrote, which is worse than
  // reporting it, because nothing on screen ever says the schedule changed.
  assert.equal(parseRecurrence("every week on Monday, Funday"), undefined);
  assert.equal(parseRecurrence("every week on Monday and Blursday"), undefined);
  assert.equal(parseRecurrence("every week on mon, tue, xyz"), undefined);
  assert.equal(parseRecurrence("every 2 weeks on Someday, Friday"), undefined);
  assert.equal(parseRecurrence("every month on the ninth Monday"), undefined);

  const unsupported = parse("- [ ] Odd [due:: 2026-07-02] [repeat:: every blue moon]", "u.md", PRO);
  assert.equal(unsupported.tasks.length, 1, "an untranslatable rule still exports a single event");
  assert.equal(unsupported.skipped[0].reason, "unsupported-recurrence");

  // An ordinal BYDAY must still agree with the date the task is on, or clients
  // disagree about whether the first occurrence exists.
  const wrongOrdinal = parse("- [ ] Board [due:: 2026-07-20] [repeat:: every month on the first Monday]", "o.md", PRO);
  assert.equal(wrongOrdinal.tasks[0].recurrence, undefined, "2026-07-20 is the third Monday, not the first");
  assert.equal(wrongOrdinal.skipped[0].reason, "unsupported-recurrence");
  const rightOrdinal = parse("- [ ] Board [due:: 2026-07-06] [repeat:: every month on the first Monday]", "o.md", PRO);
  assert.equal(rightOrdinal.tasks[0].recurrence.rrule, "FREQ=MONTHLY;BYDAY=1MO");
  const lastFriday = parse("- [ ] Retro [due:: 2026-07-31] [repeat:: every month on the last Friday]", "o.md", PRO);
  assert.equal(lastFriday.tasks[0].recurrence.rrule, "FREQ=MONTHLY;BYDAY=-1FR");
}

// --- Unicode tags: every non-English vault depends on this --------------------

{
  // The ASCII-only tag class truncated the tag AND left its tail in the event
  // title, so a French or Spanish user's calendar was full of stray letters.
  const accented = parse("- [ ] Réunion [due:: 2026-07-02] #café").tasks[0];
  assert.equal(accented.title, "Réunion");
  assert.deepEqual(accented.tags, ["café"]);

  const spanish = parse("- [ ] Llamada [due:: 2026-07-02] #niño").tasks[0];
  assert.equal(spanish.title, "Llamada");
  assert.deepEqual(spanish.tags, ["niño"]);

  const japanese = parse("- [ ] 会議 [due:: 2026-07-02] #仕事").tasks[0];
  assert.equal(japanese.title, "会議");
  assert.deepEqual(japanese.tags, ["仕事"]);

  const cyrillic = parse("- [ ] Встреча [due:: 2026-07-02] #работа").tasks[0];
  assert.equal(cyrillic.title, "Встреча");
  assert.deepEqual(cyrillic.tags, ["работа"]);

  const german = parse("- [ ] Termin [due:: 2026-07-02] #über/wichtig").tasks[0];
  assert.equal(german.title, "Termin");
  assert.deepEqual(german.tags, ["über/wichtig"]);

  // A decomposed accent (e + U+0301, what macOS filenames and some IMEs
  // produce) must behave exactly like a precomposed one.
  const decomposed = parse("- [ ] Reunion [due:: 2026-07-02] #cafe\u0301").tasks[0];
  assert.equal(decomposed.title, "Reunion", "a combining mark must not be left behind in the title");
  assert.deepEqual(decomposed.tags, ["cafe\u0301"]);

  // And the rules that were already right must stay right.
  assert.deepEqual(parse("- [ ] Fix #123 [due:: 2026-07-02]").tasks[0].tags, [], "an issue number is not a tag");
  assert.equal(parse("- [ ] Fix #123 [due:: 2026-07-02]").tasks[0].title, "Fix #123");
  assert.deepEqual(parse("- [ ] Learn C# [due:: 2026-07-02] #dev").tasks[0].tags, ["dev"]);

  // A trailing Unicode tag on a free-text field value must be trimmed off it.
  assert.equal(parse("- [ ] T [due:: 2026-07-02] [duration:: 45m #仕事]").tasks[0].durationMinutes, 45);
}

// --- A fence inside a callout must not swallow the note ----------------------

{
  // Closing a callout's code block without the leading `>` is a constant slip.
  // The fence used to stay open, hunt for a same-depth closer arbitrarily far
  // down the note, and mark every line in between as code — deleting real dated
  // tasks with NOTHING in the skip report to say where they went.
  const leaked = parse(
    "> [!note] Setup\n" +
      "> ```bash\n" +
      "> npm install\n" +
      "```\n" +
      "\n" +
      "- [ ] Ship the release [due:: 2026-08-03]\n" +
      "- [ ] Email the client [due:: 2026-08-04]\n" +
      "\n" +
      "> [!tip] Later\n" +
      "> ```bash\n" +
      "> npm prune\n" +
      "> ```\n"
  );
  assert.deepEqual(leaked.tasks.map((t) => t.title), ["Ship the release", "Email the client"], "a stray callout fence must not delete real tasks");

  // The mirror case: the abandoned fence must not swallow a later genuine code
  // block either, leaking documentation tasks into the calendar.
  const docs = parse("> [!note] Setup\n> ```bash\n> npm install\n```\n\n```markdown\n- [ ] Example from the docs [due:: 2026-08-03]\n```\n");
  assert.deepEqual(docs.tasks.map((t) => t.title), [], "a real code block still hides its example tasks");

  // The lines the abandoned fence DID cover are still code. Dropping the fence
  // without marking them let an example task written inside a callout's code
  // block escape into the calendar as a real commitment.
  const insideCallout = parse(
    "> [!note] Setup\n" + "> ```markdown\n" + "> - [ ] Example inside the callout [due:: 2026-08-03]\n" + "```\n" + "- [ ] Real task [due:: 2026-08-04]\n"
  );
  assert.deepEqual(insideCallout.tasks.map((t) => t.title), ["Real task"], "code inside the callout stays code; the task after it is real");

  // And the unquoted fence that ended it must not go on to open a stray
  // top-level fence that hides every later callout's code block.
  const afterStray = parse(
    "> [!note] A\n" +
      "> ```markdown\n" +
      "> - [ ] Example A [due:: 2026-08-03]\n" +
      "```\n" +
      "- [ ] Real one [due:: 2026-08-04]\n" +
      "\n" +
      "> [!note] B\n" +
      "> ```markdown\n" +
      "> - [ ] Example B [due:: 2026-08-05]\n" +
      "> ```\n" +
      "- [ ] Real two [due:: 2026-08-06]\n"
  );
  assert.deepEqual(afterStray.tasks.map((t) => t.title), ["Real one", "Real two"]);

  // A properly closed callout fence still hides what is inside it.
  const closed = parse("> [!note] Setup\n> ```markdown\n> - [ ] Example [due:: 2026-08-03]\n> ```\n- [ ] Real [due:: 2026-08-04]");
  assert.deepEqual(closed.tasks.map((t) => t.title), ["Real"]);

  // A blank line does not end the blockquote, so a fence spanning one survives.
  const withBlank = parse("> ```markdown\n>\n> - [ ] Example [due:: 2026-08-03]\n> ```\n- [ ] Real [due:: 2026-08-04]");
  assert.deepEqual(withBlank.tasks.map((t) => t.title), ["Real"]);
}

// --- A typo in a date that is not placing the event ---------------------------

{
  // Tasks-plugin users routinely set both ⏳ and 📅. One fat-fingered deadline
  // used to remove the meeting from the calendar entirely, even though the
  // scheduled date that actually places it was perfectly valid.
  const badDue = parse("- [ ] Board meeting ⏳ 2026-08-03 📅 2026-08-32");
  assert.equal(badDue.tasks.length, 1, "a valid scheduled date still places the event");
  assert.equal(badDue.tasks[0].date, "2026-08-03");
  assert.equal(badDue.tasks[0].dueDate, undefined, "the unusable deadline is dropped, not guessed at");
  assert.equal(badDue.skipped.length, 1);
  assert.equal(badDue.skipped[0].fatal, false, "and it is reported as a warning, not a loss");

  const badStart = parse("- [ ] Board meeting 📅 2026-08-03 🛫 2026-02-30");
  assert.equal(badStart.tasks.length, 1);
  assert.equal(badStart.tasks[0].date, "2026-08-03");
  assert.equal(badStart.skipped[0].fatal, false);

  // When the only date is unusable the task genuinely cannot be placed, so it
  // is still a fatal, reported loss.
  const noneValid = parse("- [ ] Board meeting 📅 2026-08-32");
  assert.equal(noneValid.tasks.length, 0);
  assert.equal(noneValid.skipped[0].reason, "invalid-date");
  assert.equal(noneValid.skipped[0].fatal, true);

  // A task with no date at all is still reported as undated, not as invalid.
  assert.equal(parse("- [ ] Someday").skipped[0].reason, "no-date");
}

// --- 🛫 date and start:: time are two different fields ------------------------

{
  // They shared one slot, so a task carrying both lost its 🛫 date — and a task
  // whose only date was the 🛫 one vanished as undated.
  const both = parse("- [ ] Workshop 🛫 2026-08-03 [start:: 14:15]").tasks[0];
  assert.equal(both.date, "2026-08-03", "the takeoff date still places the event");
  assert.equal(both.startTime, "14:15", "and the inline field is still the time of day");
  assert.equal(both.title, "Workshop");

  // The inline field written as a date still works on its own.
  const asDate = parse("- [ ] Workshop [start:: 2026-08-03]").tasks[0];
  assert.equal(asDate.date, "2026-08-03");
  assert.equal(asDate.startTime, undefined);

  // A due date still outranks a start date for placement.
  assert.equal(parse("- [ ] W 🛫 2026-08-01 📅 2026-08-05").tasks[0].date, "2026-08-05");
}

// --- Dates at the top of the calendar range ----------------------------------

{
  // The exclusive all-day DTEND is the date plus one day, so 9999-12-31 emitted
  // `DTEND;VALUE=DATE:100000101` — nine digits, not an RFC 5545 DATE, and the
  // whole file is rejected.
  assert.equal(isValidDate("9999-12-31"), false, "a date whose DTEND would overflow is refused up front");
  assert.equal(isValidDate("9998-12-31"), true);
  assert.equal(isValidDate("1000-01-01"), true);
  assert.equal(isValidDate("0999-12-31"), false);

  const far = ics(parse("- [ ] Far future [due:: 9998-12-31]").tasks);
  assert.ok(far.includes("DTEND;VALUE=DATE:99990101"));
  for (const line of far.split("\r\n")) {
    assert.ok(!/^DTEND;VALUE=DATE:\d{9,}/.test(line), `nine-digit DATE emitted: ${line}`);
  }
}

// --- Output-path safety ------------------------------------------------------

{
  assert.equal(validateOutputPath("Projects.md").ok, false, "a typo must never be able to overwrite a note");
  assert.equal(validateOutputPath("../outside.ics").ok, false);
  assert.equal(validateOutputPath("").ok, false);
  assert.equal(validateOutputPath("Calendar/tasks.ics").ok, true);
  assert.equal(validateOutputPath("  Calendar//tasks.ics  ").path, "Calendar/tasks.ics");

  assert.equal(isInFolder("Workshop/notes.md", "Work"), false, "folder filters must match on path boundaries");
  assert.equal(isInFolder("Work/notes.md", "Work"), true);
  assert.equal(isInFolder("Work", "Work"), true);
  assert.equal(isInFolder("Archive-old/x.md", "Archive"), false);
}

// --- Line folding ------------------------------------------------------------

{
  const long = `SUMMARY:${"é".repeat(80)}`;
  const folded = foldIcsLine(long);
  for (const line of folded.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, "no folded line may exceed 75 octets");
  }
  assert.ok(folded.split("\r\n").slice(1).every((line) => line.startsWith(" ")));

  assert.equal(buildObsidianUri({ sourcePath: "A B/C.md" }, ""), undefined, "no vault name means no link, rather than a broken one");
}

fs.unlinkSync(outfile);
console.log("core tests passed");
