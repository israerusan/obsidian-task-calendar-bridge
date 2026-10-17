// The calendar view's arithmetic, release notes, explain, and diagnostics — everything the
// 1.3.0 view draws from, tested without Obsidian.
//
// src/core and src/app import zero `obsidian`, so they bundle with plain esbuild exactly as
// tests/app.test.mjs does.
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function load(entry, name) {
  const outfile = path.join(os.tmpdir(), `task-calendar-${name}-${Date.now()}.mjs`);
  await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: "node", format: "esm", target: "es2018", outfile });
  return import(`file://${outfile.replace(/\\/g, "/")}`);
}

const core = await load("src/core/index.ts", "preview-core");
const app = await load("src/app/index.ts", "preview-app");
const { sampleEventLines } = await load("src/app/SampleEvent.ts", "preview-sample");
const { occurrencesBetween, readRule, monthGrid, isoWeekNumber, shiftMonth, parseTasksFromMarkdown, parseRecurrence, isNewerVersion, notesSince, RELEASE_NOTES, explainTask, identitySource, isTaskLine } = core;
const { buildPreview, entriesByDay, isCalendarCurrent, explainLine, buildDiagnostics, classifyError, entitlements, buildCalendar, selectForExport, SharedResult } = app;

const PRO = { includeCompleted: true, includeRecurrence: true, includeReminders: true };
const FREE = { includeCompleted: false, includeRecurrence: false, includeReminders: false };
const OPTIONS = {
  calendarName: "Obsidian Tasks",
  defaultDurationMinutes: 30,
  timeMode: "floating",
  timeZone: "",
  allDayReminderTime: "09:00",
  exportTags: true,
  linkToSource: true,
};
const FROZEN = new Date("2026-10-17T12:00:00Z");
const settings = (over = {}) => ({
  isPro: false,
  autoExport: false,
  includeCompleted: false,
  includeReminders: true,
  includeRecurrence: true,
  publishEnabled: false,
  ...over,
});
const rule = (text) => parseRecurrence(text).rrule;

// --- Occurrences: the rule subset parseRecurrence writes, expanded the RFC 5545 way ----------

{
  // Daily, with an interval.
  assert.deepEqual(occurrencesBetween("2026-10-01", rule("every 3 days"), "2026-10-01", "2026-10-10"), ["2026-10-01", "2026-10-04", "2026-10-07", "2026-10-10"]);

  // Bare weekly repeats on the start date's weekday.
  assert.deepEqual(occurrencesBetween("2026-10-05", rule("every week"), "2026-10-01", "2026-10-31"), ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);

  // Every other week counts WKST=MO weeks from the start, on every listed day.
  // 2026-10-05 is a Monday; Monday and Friday, fortnightly.
  assert.deepEqual(
    occurrencesBetween("2026-10-05", rule("every 2 weeks on Monday, Friday"), "2026-10-01", "2026-10-31"),
    ["2026-10-05", "2026-10-09", "2026-10-19", "2026-10-23"]
  );

  // Weekdays.
  assert.deepEqual(occurrencesBetween("2026-10-16", rule("every weekday"), "2026-10-16", "2026-10-21"), ["2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21"]);

  // Monthly on the 31st skips the months without one, rather than moving to the 30th.
  assert.deepEqual(occurrencesBetween("2026-01-31", rule("every month"), "2026-01-01", "2026-06-30"), ["2026-01-31", "2026-03-31", "2026-05-31"]);

  // The last day of every month.
  assert.deepEqual(occurrencesBetween("2026-01-31", rule("every month on the last"), "2026-01-01", "2026-04-30"), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);

  // The first Monday and the last Friday of every month.
  assert.deepEqual(occurrencesBetween("2026-10-05", rule("every month on the first Monday"), "2026-10-01", "2027-01-31"), ["2026-10-05", "2026-11-02", "2026-12-07", "2027-01-04"]);
  assert.deepEqual(occurrencesBetween("2026-10-30", rule("every month on the last Friday"), "2026-10-01", "2027-01-31"), ["2026-10-30", "2026-11-27", "2026-12-25", "2027-01-29"]);

  // 29 February only in leap years.
  assert.deepEqual(occurrencesBetween("2024-02-29", rule("every year"), "2024-01-01", "2029-01-01"), ["2024-02-29", "2028-02-29"]);

  // Never before the start date, whatever the window.
  assert.deepEqual(occurrencesBetween("2026-10-20", rule("every day"), "2026-10-15", "2026-10-21"), ["2026-10-20", "2026-10-21"]);

  // No rule, or one this module does not read: the start date alone, if it is in range.
  assert.deepEqual(occurrencesBetween("2026-10-20", undefined, "2026-10-01", "2026-10-31"), ["2026-10-20"]);
  assert.deepEqual(occurrencesBetween("2026-10-20", undefined, "2026-11-01", "2026-11-30"), []);
  assert.deepEqual(occurrencesBetween("2026-10-20", "FREQ=WEEKLY;COUNT=3", "2026-10-01", "2026-10-31"), ["2026-10-20"]);
  assert.equal(readRule("FREQ=HOURLY"), undefined);
  assert.equal(readRule("FREQ=MONTHLY;BYDAY=5MO"), undefined, "an ordinal the parser never writes is refused, not guessed");

  // Every rule the setup guide promises is one the preview can draw. If the parser learns a
  // new rule shape, this fails until the view learns it too.
  for (const text of [
    "every day", "every 3 days", "every week", "every 2 weeks", "every other week", "every fortnight",
    "every Monday", "every Monday and Friday", "every week on Monday, Friday", "every weekday",
    "every month", "every 2 months", "every month on the 15th", "every month on the last",
    "every month on the first Monday", "every month on the last Friday", "every year",
  ]) {
    const parsed = parseRecurrence(text);
    assert.ok(parsed, `${text} parses`);
    assert.ok(readRule(parsed.rrule), `the view can expand "${text}" (${parsed.rrule})`);
  }
}

// --- Month grid --------------------------------------------------------------------------

{
  // October 2026 starts on a Thursday.
  const mondayFirst = monthGrid(2026, 10, 1, "2026-10-17");
  assert.equal(mondayFirst[0].days[0].date, "2026-09-28", "Monday-first rows start on the Monday before the 1st");
  assert.equal(mondayFirst.length, 5);
  assert.ok(mondayFirst.every((week) => week.days.length === 7));
  assert.equal(mondayFirst.flatMap((week) => week.days).filter((day) => day.isToday).length, 1);
  assert.equal(mondayFirst.flatMap((week) => week.days).filter((day) => day.inMonth).length, 31);

  const sundayFirst = monthGrid(2026, 10, 0, "2026-10-17");
  assert.equal(sundayFirst[0].days[0].date, "2026-09-27");
  assert.equal(sundayFirst[0].days[0].weekday, 0);

  // February 2027 starts on a Monday and has 28 days: exactly four rows, no borrowed week.
  assert.equal(monthGrid(2027, 2, 1, "2026-10-17").length, 4);
  // A month that needs six rows gets six.
  assert.equal(monthGrid(2026, 8, 1, "2026-10-17").length, 6, "August 2026 starts on a Saturday and needs six Monday-first rows");

  // ISO week numbers, including the ones that straddle New Year.
  assert.equal(isoWeekNumber("2026-10-17"), 42);
  assert.equal(isoWeekNumber("2027-01-01"), 53, "1 January 2027 is a Friday, so it belongs to week 53 of 2026");
  assert.equal(isoWeekNumber("2024-12-30"), 1, "30 December 2024 is a Monday in week 1 of 2025");
  assert.equal(isoWeekNumber("2026-01-01"), 1);

  // A Sunday-first row reads its week number from its Monday.
  const row = monthGrid(2026, 10, 0, "2026-10-17")[1];
  assert.equal(row.days[0].date, "2026-10-04");
  assert.equal(row.isoWeek, isoWeekNumber("2026-10-05"));

  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(shiftMonth(2026, 10, -22), { year: 2024, month: 12 });
}

// --- Preview: the view must agree with the file ------------------------------------------

const today = "2026-10-17";
const md = (lines) => lines.join("\n");

{
  // 30 dated tasks on the free tier: the next 25 are in the file, the rest are "capped".
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`- [ ] Task ${i} 📅 2026-11-${String(i + 1).padStart(2, "0")}`);
  const parsed = parseTasksFromMarkdown(md(lines), "Plan.md", FREE);
  const preview = buildPreview({ tasks: parsed.tasks, skipped: parsed.skipped, rights: entitlements(settings()), today, options: OPTIONS, vaultName: "Vault", now: FROZEN });
  assert.equal(preview.eventCount, 25);
  assert.equal(preview.capped, 5);
  assert.equal(preview.items.filter((item) => item.state === "exported").length, 25);
  assert.equal(preview.items.filter((item) => item.state === "capped").length, 5);

  // The signature is the export's: the same inputs through the real pipeline match exactly.
  const selected = selectForExport(parsed.tasks, entitlements(settings()), today);
  const built = buildCalendar({ tasks: selected.tasks, skipped: parsed.skipped, options: OPTIONS, vaultName: "Vault", now: new Date("2020-01-01T00:00:00Z") });
  assert.ok(isCalendarCurrent(preview, built.ics), "a file written at any other moment still counts as current — DTSTAMP is not content");
  assert.equal(isCalendarCurrent(preview, null), false, "a missing file is not current");
  const edited = buildCalendar({ tasks: selected.tasks.slice(1), skipped: [], options: OPTIONS, vaultName: "Vault", now: FROZEN });
  assert.equal(isCalendarCurrent(preview, edited.ics), false, "a file missing an event is stale");
  const renamed = buildCalendar({ tasks: selected.tasks, skipped: [], options: { ...OPTIONS, calendarName: "Other" }, vaultName: "Vault", now: FROZEN });
  assert.equal(isCalendarCurrent(preview, renamed.ics), false, "a settings change that changes the file makes it stale");

  // Pro: no cap.
  const pro = buildPreview({ tasks: parsed.tasks, skipped: [], rights: entitlements(settings({ isPro: true })), today, options: OPTIONS, vaultName: "Vault", now: FROZEN });
  assert.equal(pro.capped, 0);
  assert.equal(pro.items.every((item) => item.state === "exported"), true);
}

{
  // Two tasks with one explicit id: the file keeps the first, the preview says so.
  const parsed = parseTasksFromMarkdown(md(["- [ ] One [due:: 2026-10-20] [id:: same]", "- [ ] Two [due:: 2026-10-21] [id:: same]"]), "Ids.md", PRO);
  const preview = buildPreview({ tasks: parsed.tasks, skipped: [], rights: entitlements(settings({ isPro: true })), today, options: OPTIONS, vaultName: "Vault", now: FROZEN });
  assert.equal(preview.eventCount, 1);
  assert.equal(preview.duplicates, 1);
  assert.deepEqual(preview.items.map((item) => [item.task.title, item.state]), [["One", "exported"], ["Two", "duplicate"]]);
}

{
  // Entries by day: repeats expand where the export writes a rule, multi-day events continue.
  const note = md([
    "- [ ] Standup [due:: 2026-10-19] [start:: 09:00] 🔁 every weekday",
    "- [ ] Offsite [due:: 2026-10-21] [end:: 2026-10-23]",
    "- [ ] Lunch [due:: 2026-10-21] [start:: 12:30]",
  ]);
  const pro = parseTasksFromMarkdown(note, "Week.md", PRO);
  const preview = buildPreview({ tasks: pro.tasks, skipped: [], rights: entitlements(settings({ isPro: true })), today, options: OPTIONS, vaultName: "Vault", now: FROZEN });
  const days = entriesByDay(preview.items, "2026-10-19", "2026-10-25");
  assert.deepEqual(
    [...days.keys()].sort(),
    ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"],
    "weekday standups Monday to Friday, nothing at the weekend"
  );
  const wednesday = days.get("2026-10-21").map((entry) => `${entry.item.task.title}:${entry.kind}`);
  assert.deepEqual(wednesday, ["Offsite:start", "Standup:repeat", "Lunch:start"], "all-day first, then by start time");
  assert.deepEqual(days.get("2026-10-23").map((entry) => `${entry.item.task.title}:${entry.kind}`), ["Offsite:continues", "Standup:repeat"]);

  // A multi-day event that began before the window still shows on the days inside it.
  const late = entriesByDay(preview.items, "2026-10-22", "2026-10-22");
  assert.ok(late.get("2026-10-22").some((entry) => entry.item.task.title === "Offsite" && entry.kind === "continues"));

  // Free tier: the rule is dropped from the export, so the preview draws one event, not five.
  const free = parseTasksFromMarkdown(note, "Week.md", FREE);
  const freePreview = buildPreview({ tasks: free.tasks, skipped: [], rights: entitlements(settings()), today, options: OPTIONS, vaultName: "Vault", now: FROZEN });
  const freeDays = entriesByDay(freePreview.items, "2026-10-19", "2026-10-25");
  assert.equal(
    [...freeDays.values()].flat().filter((entry) => entry.item.task.title === "Standup").length,
    1,
    "the preview must not promise a repeat the file does not contain"
  );
}

{
  // A long one-off event keeps every one of its days, however far from its start the window is.
  const parsed = parseTasksFromMarkdown("- [ ] Sabbatical [due:: 2026-01-01] [end:: 2026-06-30]", "Long.md", PRO);
  const preview = buildPreview({ tasks: parsed.tasks, skipped: [], rights: entitlements(settings({ isPro: true })), today, options: OPTIONS, vaultName: "Vault", now: FROZEN });
  const june = entriesByDay(preview.items, "2026-06-01", "2026-06-30");
  assert.equal(june.size, 30, "every June day of a January-to-June event is drawn");
  assert.equal(entriesByDay(preview.items, "2026-07-01", "2026-07-31").size, 0, "and nothing after it ends");
  assert.equal(entriesByDay(preview.items, "2025-12-01", "2025-12-31").size, 0, "or before it starts");

  // A repeating multi-day event that began before the window still shows inside it.
  const weekly = parseTasksFromMarkdown("- [ ] Course [due:: 2026-10-05] [end:: 2026-10-07] 🔁 every week", "Course.md", PRO);
  const wp = buildPreview({ tasks: weekly.tasks, skipped: [], rights: entitlements(settings({ isPro: true })), today, options: OPTIONS, vaultName: "Vault", now: FROZEN });
  const days = entriesByDay(wp.items, "2026-10-13", "2026-10-13");
  assert.deepEqual(days.get("2026-10-13").map((entry) => entry.kind), ["continues"], "Monday's instance is still running on Tuesday");
}

// --- SharedResult: one computation at a time, never a stale answer -------------------------

{
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  let runs = 0;
  const releases = [];
  const shared = new SharedResult(() => {
    runs++;
    const run = runs;
    return new Promise((resolve) => releases.push(() => resolve(run)));
  });

  const a = shared.get();
  const b = shared.get();
  assert.equal(runs, 1, "two callers, one computation");

  shared.invalidate();
  const c = shared.get();
  const d = shared.get();
  assert.equal(runs, 1, "an invalidation while running does not start a second computation alongside it");

  releases[0]();
  assert.equal(await a, 1);
  assert.equal(await b, 1);
  await flush();
  assert.equal(runs, 2, "exactly one follow-up for everyone who asked after the invalidation");
  releases[1]();
  assert.equal(await c, 2, "a caller after an invalidation never receives the older result");
  assert.equal(await d, 2);

  assert.equal(await shared.get(), 2, "cached until the next invalidation");
  assert.equal(runs, 2);

  // Failures are not cached.
  let fail = true;
  const flaky = new SharedResult(async () => {
    if (fail) throw new Error("boom");
    return "ok";
  });
  await assert.rejects(flaky.get(), /boom/);
  fail = false;
  assert.equal(await flaky.get(), "ok");
}

// --- Release notes -------------------------------------------------------------------------

{
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(RELEASE_NOTES[0].version, manifest.version, "the newest release notes must be for the version being shipped");
  for (const release of RELEASE_NOTES) {
    assert.ok(release.highlights.length > 0 && release.highlights.length <= 5, `${release.version}: one to five highlights`);
  }
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  assert.ok(changelog.includes(`## [${manifest.version}]`), "CHANGELOG.md has an entry for this version");

  assert.equal(isNewerVersion("1.10.0", "1.9.0"), true, "numeric, not lexical");
  assert.equal(isNewerVersion("1.3.0", "1.3.0"), false);
  assert.equal(isNewerVersion("1.2.1", "1.3.0"), false, "a downgrade is not newer");
  assert.equal(isNewerVersion("1.3.0", "garbage"), false, "a malformed stored version never triggers the modal");
  assert.deepEqual(notesSince("1.2.1", "1.3.0").map((notes) => notes.version), ["1.3.0"]);
  assert.deepEqual(notesSince("1.3.0", "1.3.0"), []);
  assert.deepEqual(notesSince("0", "1.2.1"), [], "an old build never shows notes from the future");
}

// --- Explain ----------------------------------------------------------------------------------

{
  const note = md([
    "# Plan",
    "- [ ] Call Sam [due:: 2026-10-20] [start:: 14:15] [reminder:: 10m] #work ^call",
    "- [ ] Undated idea",
    "```",
    "- [ ] Example in a fence 📅 2026-10-20",
    "```",
    "- [ ] Review [due:: 2026-10-20] [start:: 25:99]",
    "- [x] Done thing 📅 2026-10-20",
    "- [ ] Weekly sync [due:: 2026-10-19] 🔁 every week on Monday",
  ]);
  const base = {
    markdown: note,
    sourcePath: "Plan.md",
    parseOptions: PRO,
    explainOptions: { defaultDurationMinutes: 30, allDayReminderTime: "09:00", timeMode: "floating", timeZone: "", exportTags: true },
    inVaultScope: true,
    freeLimit: 25,
  };

  const ok = explainLine({ ...base, line: 2 });
  assert.equal(ok.excluded, false);
  assert.equal(ok.headline, "Exports as a calendar event:");
  const rows = Object.fromEntries(ok.rows.map((row) => [row.label, row.value]));
  assert.match(rows.When, /2026-10-20 at 14:15/);
  assert.match(rows.Duration, /30 min \(the default duration\)/);
  assert.match(rows.Reminder, /10 min before/);
  assert.equal(rows.Categories, "work");
  assert.match(rows.Identity, /block id/);

  assert.match(explainLine({ ...base, line: 1 }).headline, /not a task/);
  const undated = explainLine({ ...base, line: 3 });
  assert.equal(undated.excluded, true);
  assert.match(undated.headline, /no date/i);
  assert.match(explainLine({ ...base, line: 5 }).headline, /code block/);

  const badTime = explainLine({ ...base, line: 7 });
  assert.equal(badTime.excluded, false, "a bad time degrades the field, the task still exports");
  assert.match(badTime.headline, /ignored/);
  assert.ok(badTime.issues.some((issue) => issue.label === "Invalid time"));

  const done = explainLine({ ...base, line: 8, parseOptions: FREE });
  assert.equal(done.excluded, true);
  assert.match(done.headline, /completed/);

  const repeat = explainLine({ ...base, line: 9 });
  assert.match(Object.fromEntries(repeat.rows.map((row) => [row.label, row.value])).Repeats, /FREQ=WEEKLY;BYDAY=MO/);

  assert.match(explainLine({ ...base, line: 2, inVaultScope: false }).headline, /folder filters/);
  assert.match(explainLine({ ...base, line: 2, vaultState: () => "capped" }).headline, /free tier/);
  assert.match(explainLine({ ...base, line: 2, vaultState: () => "duplicate" }).headline, /same identity/);
  // Asked by location AND identity, so the caller can tell a shifted line from the same task.
  const asked = [];
  explainLine({ ...base, line: 2, vaultState: (p, l, uid) => (asked.push(`${p}:${l}:${uid.startsWith("tcb-")}`), "exported") });
  assert.deepEqual(asked, ["Plan.md:2:true"]);
  // No vault picture at all (the preview failed): still described as an export, never "in your calendar".
  assert.match(explainLine({ ...base, line: 2, vaultState: () => undefined }).headline, /^Exports as a calendar event/);

  assert.equal(isTaskLine("> - [ ] In a callout"), true);
  assert.equal(isTaskLine("- [ ] "), false, "an empty task is not a task");
  assert.equal(isTaskLine("Some prose"), false);

  const [derived] = parseTasksFromMarkdown("- [ ] Plain 📅 2026-10-20", "A.md", PRO).tasks;
  const [explicit] = parseTasksFromMarkdown("- [ ] Plain 📅 2026-10-20 [id:: abc]", "A.md", PRO).tasks;
  assert.equal(identitySource(derived), "derived");
  assert.equal(identitySource(explicit), "explicit");
  assert.ok(explainTask(derived, base.explainOptions).some((row) => /renaming the note/.test(row.value)));
}

// --- Diagnostics -------------------------------------------------------------------------------

let baseDiagnosticsSettings;
{
  const text = buildDiagnostics({
    pluginVersion: "1.3.0",
    obsidianVersion: "1.7.2",
    platform: "Windows",
    publishSupported: true,
    settings: (baseDiagnosticsSettings = {
      licenseKey: "SECRET.KEY",
      isPro: true,
      licenseEmail: "buyer@example.com",
      calendarName: "My private calendar",
      vaultOutputPath: "Calendar/tasks.ics",
      currentNoteOutputPath: "Calendar/current-note.ics",
      defaultDurationMinutes: 30,
      timeMode: "zoned",
      timeZone: "Europe/Madrid",
      allDayReminderTime: "09:00",
      exportTags: true,
      linkToSource: true,
      autoExport: true,
      includeCompleted: false,
      includeReminders: true,
      includeRecurrence: true,
      includeFolders: "Work, Clients/Acme",
      excludeFolders: "",
      publishEnabled: true,
      publishPath: "C:\\Users\\alice\\Dropbox\\cal",
      lastExport: {
        at: "2026-10-17T10:00:00.000Z",
        scope: "whole vault",
        path: "Calendar/tasks.ics",
        eventCount: 40,
        skippedCount: 1,
        counts: { lost: 1, warnings: 2, excluded: 3 },
        skipped: [{ sourcePath: "Secret/Plan.md", line: 3, reason: "no-date", detail: "Call my lawyer", excerpt: "- [ ] Call my lawyer", fatal: true }],
        publishError: "Could not write to C:\\Users\\alice\\Dropbox\\cal: EBUSY",
      },
      ownedPaths: [],
      hasOnboarded: true,
      weekStart: "locale",
      showWeekNumbers: false,
      previewShowCapped: true,
      showReleaseNotes: true,
      lastSeenVersion: "1.3.0",
    }),
  });
  for (const secret of ["SECRET", "buyer@example.com", "My private calendar", "alice", "Clients/Acme", "lawyer", "Secret/Plan"]) {
    assert.ok(!text.includes(secret), `diagnostics must not contain ${secret}:\n${text}`);
  }
  assert.match(text, /Version: 1\.3\.0/);
  assert.match(text, /Pro/);
  assert.match(text, /Europe\/Madrid/);
  assert.match(text, /include 2 folders/);
  assert.match(text, /no-date ×1/);
  assert.match(text, /Publish error: publish write failed, EBUSY/);

  // Error messages are categorised, never copied: none of these may survive, whatever shape
  // the path takes.
  const failures = [
    "Projects/Acquisition/Foo Corp.md is no longer a file in this vault.",
    "Calendar/Client X/tasks.ics already exists and was not created by this plugin. Choose another output path.",
    "Could not write to C:\Users\alice\Dropbox\Secret Client: EACCES: permission denied",
    "Could not write to \\server\share\Board Minutes: EBUSY",
    "Could not write to /Users/alice/Mes Clients/日本: ENOENT",
    "\"Private Folder\" is not an absolute folder path. Use the full path, for example /Users/you/Dropbox/calendar.",
    "Something nobody anticipated about Acme Corp",
  ];
  for (const message of failures) {
    const category = classifyError(message);
    for (const secret of ["Acquisition", "Foo Corp", "Client X", "alice", "Secret Client", "Board Minutes", "Mes Clients", "日本", "Private Folder", "Acme"]) {
      assert.ok(!category.includes(secret), `"${category}" leaks "${secret}"`);
    }
  }
  assert.equal(classifyError(failures[0]), "a note vanished during export");
  assert.equal(classifyError(failures[1]), "output path belongs to another file");
  assert.equal(classifyError(failures[2]), "publish write failed, EACCES");
  assert.equal(classifyError(failures[5]), "publish folder not absolute");
  assert.equal(classifyError(failures[6]), "other error");
  assert.equal(classifyError("The path must end in .ics so the plugin can never overwrite a note."), "invalid output path");
  assert.equal(classifyError("The vault and current-note output paths are the same file. Give them different paths."), "output paths are the same file");

  const failed = buildDiagnostics({
    pluginVersion: "1.3.0",
    obsidianVersion: "1.7.2",
    platform: "macOS",
    publishSupported: true,
    settings: { ...JSON.parse(JSON.stringify(baseDiagnosticsSettings)), lastExport: { at: "2026-10-17T10:00:00.000Z", scope: "whole vault", path: "Calendar/tasks.ics", eventCount: 0, skippedCount: 0, error: failures[0] } },
  });
  assert.match(failed, /FAILED \(a note vanished during export\)/);
  assert.ok(!failed.includes("Acquisition"));
}

// --- The settings example is what the exporter writes ------------------------------------------

{
  const floating = sampleEventLines(OPTIONS, today, FROZEN);
  assert.deepEqual(floating, ["DTSTART:20261018T090000", "DURATION:PT30M"]);
  const zoned = sampleEventLines({ ...OPTIONS, timeMode: "zoned", timeZone: "Europe/Madrid", defaultDurationMinutes: 45 }, today, FROZEN);
  assert.deepEqual(zoned, ["DTSTART;TZID=Europe/Madrid:20261018T090000", "DURATION:PT45M"]);
}

console.log("preview tests passed");
