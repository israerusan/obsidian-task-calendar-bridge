// The export pipeline, tested.
//
// src/app imports zero `obsidian`, so it bundles with the same esbuild recipe core does — no
// alias, no loader hook, no fake module. That is the whole point of where the seam was drawn:
// node_modules/obsidian ships types only, so anything that imports it is unreachable from a test.
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outfile = path.join(os.tmpdir(), `task-calendar-app-${Date.now()}.mjs`);

await build({
  entryPoints: [path.join(root, "src/app/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2018",
  outfile,
});

const app = await import(`file://${outfile.replace(/\\/g, "/")}`);
const { entitlements, precheckExport, selectForExport, buildCalendar, planReport, summariseExport } = app;

const coreOut = path.join(os.tmpdir(), `task-calendar-app-core-${Date.now()}.mjs`);
await build({
  entryPoints: [path.join(root, "src/core/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2018",
  outfile: coreOut,
});
const { parseTasksFromMarkdown } = await import(`file://${coreOut.replace(/\\/g, "/")}`);

const FROZEN = new Date("2026-01-01T00:00:00Z");
const OPTIONS = {
  calendarName: "Obsidian Tasks",
  defaultDurationMinutes: 30,
  timeMode: "floating",
  timeZone: "",
  allDayReminderTime: "09:00",
  exportTags: true,
  linkToSource: true,
};

const settings = (over = {}) => ({
  isPro: false,
  autoExport: false,
  includeCompleted: false,
  includeReminders: true,
  includeRecurrence: true,
  publishEnabled: false,
  ...over,
});

// --- Entitlements: the 22 gate sites, as a truth table ------------------------

{
  // The free tier. Note includeReminders and includeRecurrence are stored TRUE by default, so
  // every one of these is load-bearing: drop a conjunct and a paid feature ships for free.
  const free = entitlements(settings());
  assert.equal(free.pro, false);
  assert.equal(free.taskLimit, 25, "the free tier is capped");
  assert.equal(free.includeReminders, false, "stored true, but not entitled");
  assert.equal(free.includeRecurrence, false, "stored true, but not entitled");
  assert.equal(free.autoExport, false);
  assert.equal(free.includeCompleted, false);
  assert.equal(free.useIncludeFolders, false);
  assert.equal(free.publish, false);

  // Pro, with everything the user could switch on.
  const pro = entitlements(settings({ isPro: true, autoExport: true, includeCompleted: true, publishEnabled: true }));
  assert.equal(pro.taskLimit, null, "Pro has no cap");
  assert.deepEqual(
    { autoExport: pro.autoExport, completed: pro.includeCompleted, reminders: pro.includeReminders, recurrence: pro.includeRecurrence, publish: pro.publish },
    { autoExport: true, completed: true, reminders: true, recurrence: true, publish: true }
  );

  // Pro with the toggles off: entitled, but not asked for.
  const quiet = entitlements(settings({ isPro: true, includeReminders: false, includeRecurrence: false }));
  assert.equal(quiet.includeReminders, false);
  assert.equal(quiet.includeRecurrence, false);
  assert.equal(quiet.useIncludeFolders, true, "the include list is a capability, not a toggle");

  // The one inverted gate: publishing switched on but no longer running. The copy other people
  // subscribed to is frozen, so this has to produce a warning rather than silence.
  assert.equal(entitlements(settings({ publishEnabled: true, isPro: false })).publishIsInert, true);
  assert.equal(entitlements(settings({ publishEnabled: true, isPro: true })).publishIsInert, false);
  assert.equal(entitlements(settings({ publishEnabled: false, isPro: false })).publishIsInert, false);

  // Exhaustive: no derived right may ever be true without the licence, except the inert warning.
  for (const autoExport of [true, false]) {
    for (const includeCompleted of [true, false]) {
      for (const publishEnabled of [true, false]) {
        const rights = entitlements(settings({ isPro: false, autoExport, includeCompleted, publishEnabled }));
        for (const key of ["autoExport", "includeCompleted", "includeRecurrence", "includeReminders", "useIncludeFolders", "publish"]) {
          assert.equal(rights[key], false, `${key} must be false without a license`);
        }
        assert.equal(rights.taskLimit, 25);
      }
    }
  }
}

// --- Precheck: the refusals, in the order they must happen --------------------

{
  const base = { settingsUnreadable: false, dataPath: "P/data.json", rawPath: "Calendar/tasks.ics", vaultOutputPath: "Calendar/tasks.ics", currentNoteOutputPath: "Calendar/current-note.ics" };

  assert.deepEqual(precheckExport(base), { ok: true, path: "Calendar/tasks.ics" });

  // Unreadable settings refuses FIRST. Everything below it would be an invented default —
  // including the output path, which the overwrite guard would then wave through because the
  // file it is about to destroy is one of ours.
  const unreadable = precheckExport({ ...base, settingsUnreadable: true, rawPath: "" });
  assert.equal(unreadable.ok, false);
  assert.ok(unreadable.message.includes("P/data.json"), "the message must say where the file is");
  assert.ok(!unreadable.message.includes("Enter a path"), "the path check must not run first");

  // A typo that could destroy a note.
  assert.equal(precheckExport({ ...base, rawPath: "Projects.md" }).ok, false);
  assert.equal(precheckExport({ ...base, rawPath: "../outside.ics" }).ok, false);

  // The two scopes must not be one file — compared the way the filesystem compares them.
  assert.equal(precheckExport({ ...base, currentNoteOutputPath: "Calendar/TASKS.ics" }).ok, false);
}

// --- The free cap ------------------------------------------------------------

{
  const markdown = [];
  for (let i = 1; i <= 40; i++) markdown.push(`- [ ] Task ${i} [due:: 2026-08-${String((i % 28) + 1).padStart(2, "0")}]`);
  const all = parseTasksFromMarkdown(markdown.join("\n"), "N.md", { includeCompleted: true, includeRecurrence: true, includeReminders: true }).tasks;

  const capped = selectForExport(all, entitlements(settings()), "2026-08-15");
  assert.equal(capped.tasks.length, 25);
  assert.equal(capped.totalFound, 40);
  assert.equal(capped.capped, 15);

  const uncapped = selectForExport(all, entitlements(settings({ isPro: true })), "2026-08-15");
  assert.equal(uncapped.tasks.length, 40);
  assert.equal(uncapped.capped, 0, "Pro is never reported as capped");
  // Pro output is sorted, because the ICS must be stable between runs.
  const dates = uncapped.tasks.map((t) => t.date);
  assert.deepEqual(dates, [...dates].sort(), "a Pro export must still be ordered");
}

// --- Golden calendar: the bytes 1.2.0 produces --------------------------------

{
  // Captured from the shipped 1.2.0 pipeline. Every later refactor must reproduce it exactly.
  // If this fails, the change altered what users' calendars contain — which may be correct, but
  // is never incidental, and belongs in the release notes.
  const fixture = [
    "# Fixture",
    "",
    "- [ ] Ship the release [due:: 2026-08-03] #work",
    "- [ ] Standup [due:: 2026-08-03] [start:: 09:00] [duration:: 15m] #work",
    "- [ ] Conference [due:: 2026-08-05] [end:: 2026-08-07]",
    "- [ ] Undated task",
    "- [x] Finished [due:: 2026-08-01]",
  ].join("\n");

  const parsed = parseTasksFromMarkdown(fixture, "Projects/Alpha.md", { includeCompleted: false, includeRecurrence: false, includeReminders: false });
  const selected = selectForExport(parsed.tasks, entitlements(settings({ isPro: true })), "2026-08-01");
  const built = buildCalendar({ tasks: selected.tasks, skipped: parsed.skipped, options: OPTIONS, vaultName: "My Vault", now: FROZEN });

  const goldenPath = path.join(root, "tests/fixtures/golden-export.ics");
  if (process.env.TCB_WRITE_GOLDEN) {
    fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
    fs.writeFileSync(goldenPath, built.ics, "utf8");
    console.log("wrote golden fixture");
  }
  const golden = fs.readFileSync(goldenPath, "utf8");
  assert.equal(
    built.ics,
    golden,
    "The generated calendar changed.\n" +
      "Every user who has imported this file will see the difference. If it is intended, refresh\n" +
      "the fixture with TCB_WRITE_GOLDEN=1 and say what changed in the release notes."
  );

  // The signature ignores DTSTAMP and nothing else, so an unchanged export is not rewritten.
  const later = buildCalendar({ tasks: selected.tasks, skipped: parsed.skipped, options: OPTIONS, vaultName: "My Vault", now: new Date("2026-09-09T09:09:09Z") });
  assert.notEqual(later.ics, built.ics);
  assert.equal(later.signature, built.signature);

  assert.equal(built.eventCount, 3);
  assert.equal(built.counts.lost, 1, "the undated task");
  assert.equal(built.counts.excluded, 1, "the completed task");
}

// --- The report, and the notice that points at it -----------------------------

{
  const parsed = parseTasksFromMarkdown("- [ ] A [due:: 2026-08-03]\n- [ ] Undated", "N.md", { includeCompleted: false, includeRecurrence: false, includeReminders: false });
  const built = buildCalendar({ tasks: parsed.tasks, skipped: parsed.skipped, options: OPTIONS, vaultName: "V", now: FROZEN });
  const { report, lastExport } = planReport(built, { scope: "whole vault", path: "Calendar/tasks.ics", totalFound: 2, capped: 0, freeLimit: 25, now: FROZEN });

  assert.equal(report.eventCount, 1);
  assert.equal(report.counts.lost, 1);
  assert.equal(lastExport.at, FROZEN.toISOString(), "the timestamp is injected, not read from the clock");
  assert.equal(lastExport.skippedCount, report.counts.lost, "the persisted count is genuine losses only");

  // A publish failure outranks everything: the file on disk is right, the copy people
  // subscribed to is not.
  const failed = planReport(built, { scope: "whole vault", path: "P.ics", totalFound: 2, capped: 0, freeLimit: 25, now: FROZEN, publishError: "disk full" });
  assert.ok(summariseExport(failed.report, false).message.includes("disk full"));

  // The cap upsell is spent once per session, and the formatter says so instead of reaching
  // back into the plugin to set a flag.
  const cappedReport = planReport(built, { scope: "whole vault", path: "P.ics", totalFound: 540, capped: 515, freeLimit: 25, now: FROZEN }).report;
  const first = summariseExport({ ...cappedReport, counts: { lost: 0, warnings: 0, excluded: 0 } }, false);
  assert.ok(first.message.includes("540"), "the first capped export explains the cap");
  assert.equal(first.capNoticeShown, true);
  const second = summariseExport({ ...cappedReport, counts: { lost: 0, warnings: 0, excluded: 0 } }, true);
  assert.ok(!second.message.includes("540"), "and the second does not repeat it");
  assert.equal(second.capNoticeShown, true);

  // Losses outrank the upsell — the actionable problem must not be crowded out by a sales line.
  const lossy = summariseExport(cappedReport, false);
  assert.ok(lossy.message.includes("could not be exported"));
  assert.equal(lossy.capNoticeShown, false, "and the upsell is not spent while it is suppressed");

  // An empty calendar is worth saying out loud; most apps refuse to import one.
  const empty = planReport(buildCalendar({ tasks: [], skipped: [], options: OPTIONS, vaultName: "V", now: FROZEN }), {
    scope: "whole vault",
    path: "P.ics",
    totalFound: 0,
    capped: 0,
    freeLimit: 25,
    now: FROZEN,
  }).report;
  assert.ok(summariseExport(empty, false).message.includes("no events"));
}

fs.unlinkSync(outfile);
fs.unlinkSync(coreOut);
console.log("app tests passed");
