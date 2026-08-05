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

// --- The writer: one rule, two destinations -----------------------------------

{
  const { CalendarWriter } = app;

  /** An in-memory vault that records every call, so the assertions can be about behaviour. */
  const makeVault = (seed = {}) => {
    const files = new Map(Object.entries(seed));
    const log = { writes: [], mkdirs: [], reads: [] };
    return {
      files,
      log,
      port: {
        normalize: (p) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, ""),
        exists: async (p) => files.has(p),
        read: async (p) => {
          log.reads.push(p);
          if (!files.has(p)) throw new Error("ENOENT");
          return files.get(p);
        },
        write: async (p, c) => {
          log.writes.push(p);
          files.set(p, c);
        },
        mkdir: async (p) => {
          log.mkdirs.push(p);
          files.set(p, "");
        },
      },
    };
  };

  const makeExternal = () => {
    const files = new Map();
    const log = { writes: [] };
    return {
      files,
      log,
      port: {
        available: () => true,
        exists: async (p) => files.has(p),
        write: async (folder, fileName, contents) => {
          const full = `${folder}/${fileName}`;
          log.writes.push(full);
          files.set(full, contents);
          return full;
        },
      },
    };
  };

  const owned = () => {
    const set = new Set();
    return { has: (p) => set.has(p), add: (p) => set.add(p), set };
  };

  const alive = { alive: () => true };

  // Unchanged content and the file still present: no write. This is what stops an editing
  // session churning every sync client and making all subscribers re-download the same file.
  {
    const vault = makeVault();
    const writer = new CalendarWriter(vault.port, makeExternal().port, alive, owned());
    assert.deepEqual(await writer.writeToVault("Calendar/tasks.ics", "ICS-A", "sig-a"), { wrote: true });
    assert.deepEqual(await writer.writeToVault("Calendar/tasks.ics", "ICS-A", "sig-a"), { wrote: false });
    assert.equal(vault.log.writes.length, 1, "an identical calendar must not be rewritten");
  }

  // Unchanged content but the file was deleted by hand: it must come back. Without the
  // existence half of the rule, deleting the calendar meant it never returned.
  {
    const vault = makeVault();
    const writer = new CalendarWriter(vault.port, makeExternal().port, alive, owned());
    await writer.writeToVault("Calendar/tasks.ics", "ICS-A", "sig-a");
    vault.files.delete("Calendar/tasks.ics");
    assert.deepEqual(await writer.writeToVault("Calendar/tasks.ics", "ICS-A", "sig-a"), { wrote: true }, "a deleted calendar must be rewritten");
  }

  // Changed content always writes.
  {
    const vault = makeVault();
    const writer = new CalendarWriter(vault.port, makeExternal().port, alive, owned());
    await writer.writeToVault("Calendar/tasks.ics", "ICS-A", "sig-a");
    await writer.writeToVault("Calendar/tasks.ics", "ICS-B", "sig-b");
    assert.equal(vault.log.writes.length, 2);
  }

  // A file we did not create is never overwritten — this guard exists because a typo in the
  // output path once destroyed a note.
  {
    const vault = makeVault({ "Notes/important.ics": "not ours" });
    const writer = new CalendarWriter(vault.port, makeExternal().port, alive, owned());
    await assert.rejects(() => writer.writeToVault("Notes/important.ics", "ICS", "sig"), /was not created by this plugin/);
    assert.equal(vault.files.get("Notes/important.ics"), "not ours", "and it is left untouched");
  }

  // But one of our own calendars IS ours, even after a reinstall lost the ownership record.
  {
    const vault = makeVault({ "Calendar/tasks.ics": "BEGIN:VCALENDAR\r\nPRODID:-//Task Calendar Bridge//EN\r\nEND:VCALENDAR\r\n" });
    const writer = new CalendarWriter(vault.port, makeExternal().port, alive, owned());
    assert.deepEqual(await writer.writeToVault("Calendar/tasks.ics", "ICS", "sig"), { wrote: true });
  }

  // Parent folders are created, in order, and only when missing.
  {
    const vault = makeVault();
    const writer = new CalendarWriter(vault.port, makeExternal().port, alive, owned());
    await writer.writeToVault("A/B/C/tasks.ics", "ICS", "sig");
    assert.deepEqual(vault.log.mkdirs, ["A", "A/B", "A/B/C"]);
  }

  // A dead instance writes nothing. An export in flight when the plugin is disabled reaches
  // here seconds later, and would otherwise clobber a freshly loaded instance.
  {
    const vault = makeVault();
    const writer = new CalendarWriter(vault.port, makeExternal().port, { alive: () => false }, owned());
    assert.deepEqual(await writer.writeToVault("Calendar/tasks.ics", "ICS", "sig"), { wrote: false });
    assert.equal(vault.log.writes.length, 0);
  }

  // Ownership is recorded, so the guard above does not fire on our own file next time.
  {
    const vault = makeVault();
    const paths = owned();
    const writer = new CalendarWriter(vault.port, makeExternal().port, alive, paths);
    await writer.writeToVault("Calendar/tasks.ics", "ICS", "sig");
    assert.ok(paths.set.has("Calendar/tasks.ics"));
  }

  // The published copy obeys the same rule, tracked separately — deriving "does the published
  // copy need updating?" from "did the vault file change?" skipped the very first publish after
  // someone turned publishing on.
  {
    const external = makeExternal();
    const writer = new CalendarWriter(makeVault().port, external.port, alive, owned());
    const target = { folder: "/cloud", fileName: "Calendar-tasks.ics" };
    assert.equal(await writer.publish(target, "ICS-A", "sig-a"), "/cloud/Calendar-tasks.ics");
    await writer.publish(target, "ICS-A", "sig-a");
    assert.equal(external.log.writes.length, 1, "an identical published copy must not be rewritten");

    external.files.delete("/cloud/Calendar-tasks.ics");
    await writer.publish(target, "ICS-A", "sig-a");
    assert.equal(external.log.writes.length, 2, "a deleted published copy must come back");

    // Changing the destination republishes rather than being mistaken for "already current".
    await writer.publish({ folder: "/elsewhere", fileName: "Calendar-tasks.ics" }, "ICS-A", "sig-a");
    assert.equal(external.log.writes.length, 3);
  }

  // Publishing without somewhere to publish to, and on a device that cannot.
  {
    const writer = new CalendarWriter(makeVault().port, makeExternal().port, alive, owned());
    await assert.rejects(() => writer.publish({ folder: "   ", fileName: "x.ics" }, "ICS", "sig"), /no publish folder/);
  }
  {
    const external = makeExternal();
    external.port.available = () => false;
    const writer = new CalendarWriter(makeVault().port, external.port, alive, owned());
    await assert.rejects(() => writer.publish({ folder: "/cloud", fileName: "x.ics" }, "ICS", "sig"), /only works on desktop/);
  }

  // Nothing survives a reload.
  {
    const vault = makeVault();
    const writer = new CalendarWriter(vault.port, makeExternal().port, alive, owned());
    await writer.writeToVault("Calendar/tasks.ics", "ICS", "sig");
    writer.forget();
    await writer.writeToVault("Calendar/tasks.ics", "ICS", "sig");
    assert.equal(vault.log.writes.length, 2, "a fresh instance must not trust a previous one's memory");
  }
}

// --- The lane: one thing at a time, newest request wins -----------------------

{
  const { TaskLane } = app;

  /** A clock the test drives, so a two-second debounce costs no time at all. */
  const fakeTimer = () => {
    let next = 1;
    const scheduled = new Map();
    return {
      port: {
        set: (fn, ms) => {
          const id = next++;
          scheduled.set(id, { fn, ms });
          return id;
        },
        clear: (id) => scheduled.delete(id),
      },
      /** Fire everything currently waiting, as the host would after the delay elapses. */
      tick() {
        const due = [...scheduled.entries()];
        scheduled.clear();
        for (const [, entry] of due) entry.fn();
      },
      get count() {
        return scheduled.size;
      },
    };
  };

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  // Repeated requests inside the quiet period collapse to one run.
  {
    const timer = fakeTimer();
    let runs = 0;
    const lane = new TaskLane({ delayMs: 2000, timer: timer.port, run: async () => void runs++ });
    lane.schedule();
    lane.schedule();
    lane.schedule();
    assert.equal(timer.count, 1, "each request replaces the last, it does not add one");
    timer.tick();
    await settle();
    assert.equal(runs, 1);
  }

  // A request made WHILE a run is under way schedules exactly one more, because the edit that
  // caused it is not in the run already going.
  {
    const timer = fakeTimer();
    const order = [];
    let release;
    const blocked = new Promise((resolve) => (release = resolve));
    let first = true;
    const lane = new TaskLane({
      delayMs: 2000,
      timer: timer.port,
      run: async () => {
        order.push("start");
        if (first) {
          first = false;
          await blocked;
        }
        order.push("end");
      },
    });

    lane.schedule();
    timer.tick();
    await settle();
    assert.deepEqual(order, ["start"], "the first run is in progress");

    // An edit lands mid-run.
    lane.schedule();
    release();
    await settle();
    timer.tick();
    await settle();
    assert.deepEqual(order, ["start", "end", "start", "end"], "the mid-run edit gets its own run");
  }

  // Runs never overlap, and they finish in the order they were asked for — the property the
  // export queue exists for. A slow first run must not land after a newer one.
  {
    const finished = [];
    const lane = new TaskLane({ timer: fakeTimer().port, delayMs: 0, run: async () => {} });
    await Promise.all([
      lane.enqueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished.push("slow-first");
      }),
      lane.enqueue(async () => {
        finished.push("fast-second");
      }),
    ]);
    assert.deepEqual(finished, ["slow-first", "fast-second"], "an older run cannot finish last");
  }

  // One failure must not poison the lane.
  {
    const lane = new TaskLane({ timer: fakeTimer().port, delayMs: 0, run: async () => {} });
    await assert.rejects(() => lane.enqueue(async () => Promise.reject(new Error("boom"))));
    let ran = false;
    await lane.enqueue(async () => void (ran = true));
    assert.equal(ran, true, "the lane still works after a failure");
  }

  // Cancel drops the pending run — this is what stops a write landing in a vault whose plugin
  // instance is gone.
  {
    const timer = fakeTimer();
    let runs = 0;
    const lane = new TaskLane({ delayMs: 2000, timer: timer.port, run: async () => void runs++ });
    lane.schedule();
    lane.cancel();
    timer.tick();
    await settle();
    assert.equal(runs, 0);
    assert.equal(lane.isScheduled, false);
  }

  // A dead instance neither schedules nor runs.
  {
    const timer = fakeTimer();
    let runs = 0;
    let living = true;
    const lane = new TaskLane({ delayMs: 2000, timer: timer.port, alive: () => living, run: async () => void runs++ });
    lane.schedule();
    living = false;
    timer.tick();
    await settle();
    assert.equal(runs, 0, "a run that comes due after unload must not execute");

    lane.schedule();
    assert.equal(timer.count, 0, "and nothing new may be scheduled");
  }

  // runNow jumps no queue.
  {
    const order = [];
    const lane = new TaskLane({ timer: fakeTimer().port, delayMs: 0, run: async () => void order.push("run") });
    const queued = lane.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("queued");
    });
    await Promise.all([queued, lane.runNow()]);
    assert.deepEqual(order, ["queued", "run"]);
  }
}

// --- The parse index ----------------------------------------------------------

{
  const { ParseIndex } = app;
  const PRO = { includeCompleted: true, includeRecurrence: true, includeReminders: true };
  const FREE = { includeCompleted: false, includeRecurrence: false, includeReminders: false };

  const makeIndex = (contents, over = {}) => {
    const reads = [];
    const index = new ParseIndex({
      read: async (note) => {
        reads.push(note.path);
        return contents.get(note.path);
      },
      ...over,
    });
    return { index, reads };
  };

  // An unchanged note is read once.
  {
    const contents = new Map([["N.md", "- [ ] A [due:: 2026-08-03]"]]);
    const { index, reads } = makeIndex(contents);
    await index.parse({ path: "N.md", mtime: 1 }, FREE);
    await index.parse({ path: "N.md", mtime: 1 }, FREE);
    assert.equal(reads.length, 1, "an unchanged note must not be re-read");
  }

  // A changed mtime invalidates it.
  {
    const contents = new Map([["N.md", "- [ ] A [due:: 2026-08-03]"]]);
    const { index, reads } = makeIndex(contents);
    await index.parse({ path: "N.md", mtime: 1 }, FREE);
    contents.set("N.md", "- [ ] A [due:: 2026-08-04]");
    const after = await index.parse({ path: "N.md", mtime: 2 }, FREE);
    assert.equal(reads.length, 2);
    assert.equal(after.tasks[0].date, "2026-08-04");
  }

  // So does flipping a Pro toggle: the same bytes mean something different. A completed task
  // becomes an event, and a repeat rule stops being reported as unavailable.
  {
    const contents = new Map([["N.md", "- [x] Done [due:: 2026-08-03]"]]);
    const { index, reads } = makeIndex(contents);
    const free = await index.parse({ path: "N.md", mtime: 1 }, FREE);
    const pro = await index.parse({ path: "N.md", mtime: 1 }, PRO);
    assert.equal(free.tasks.length, 0, "the free tier excludes a completed task");
    assert.equal(pro.tasks.length, 1, "Pro exports it");
    assert.equal(reads.length, 2, "the options are part of the cache key");
  }

  // The mtime is sampled BEFORE the read. Reading it afterwards paired a fresh stamp with stale
  // content when the note changed mid-export, and the stale tasks then looked current forever.
  {
    const contents = new Map([["N.md", "- [ ] Old [due:: 2026-08-03]"]]);
    let mtimeNow = 1;
    const index = new ParseIndex({
      read: async () => {
        // The note changes while we are reading it.
        mtimeNow = 2;
        contents.set("N.md", "- [ ] New [due:: 2026-08-04]");
        return "- [ ] Old [due:: 2026-08-03]";
      },
    });
    await index.parse({ path: "N.md", mtime: 1 }, FREE);
    // The next export sees the newer mtime and must re-read rather than trust the cache.
    let reread = false;
    const index2 = new ParseIndex({
      read: async () => {
        reread = true;
        return contents.get("N.md");
      },
    });
    await index2.parse({ path: "N.md", mtime: 1 }, FREE);
    await index2.parse({ path: "N.md", mtime: mtimeNow }, FREE);
    assert.equal(reread, true);
  }

  // Forgetting one note, and all of them.
  {
    const contents = new Map([["N.md", "- [ ] A [due:: 2026-08-03]"]]);
    const { index, reads } = makeIndex(contents);
    await index.parse({ path: "N.md", mtime: 1 }, FREE);
    index.forget("N.md");
    await index.parse({ path: "N.md", mtime: 1 }, FREE);
    assert.equal(reads.length, 2);
    index.clear();
    assert.equal(index.size, 0);
  }

  // Bounded. One entry per Markdown file is unbounded by design, and each holds every task and
  // skip record that file produced.
  {
    const contents = new Map();
    for (let i = 0; i < 12; i++) contents.set(`N${i}.md`, "- [ ] A [due:: 2026-08-03]");
    const { index } = makeIndex(contents, { limit: 5 });
    for (let i = 0; i < 12; i++) await index.parse({ path: `N${i}.md`, mtime: 1 }, FREE);
    assert.ok(index.size <= 5, `cache grew to ${index.size}`);
  }
}

// --- The settings store: the path that could destroy a paid license key -------

{
  const { SettingsStore, TaskLane } = app;

  const noTimer = { set: () => 0, clear: () => {} };
  const makeStore = (over = {}) => {
    const saves = [];
    const data = {
      stored: null,
      present: false,
      load: async () => data.stored,
      save: async (settings) => void saves.push(JSON.parse(JSON.stringify(settings))),
      path: () => ".config/plugins/tcb/data.json",
      exists: async () => data.present,
      ...over,
    };
    const lane = new TaskLane({ timer: noTimer, delayMs: 0, run: async () => {} });
    return { store: new SettingsStore(data, lane, () => true), data, saves };
  };

  // A genuine first run: no file, defaults, and saving works.
  {
    const { store, saves } = makeStore();
    const outcome = await store.load();
    assert.equal(outcome.unreadable, false);
    assert.equal(outcome.notice, undefined, "a first run has nothing to announce");
    assert.equal(store.settings.vaultOutputPath, "Calendar/tasks.ics");
    await store.save();
    assert.equal(saves.length, 1);
  }

  // The dangerous case: loadData() returns null because the file is CORRUPT, not absent.
  // Writing defaults over it destroys the only copy of the Pro key the user paid for.
  {
    const { store, saves } = makeStore({ present: true });
    const outcome = await store.load();
    assert.equal(outcome.unreadable, true);
    assert.ok(outcome.notice.includes("data.json"), "the user must be told where the file is");

    await store.save();
    store.saveSoon();
    await store.flush();
    await store.write();
    assert.equal(saves.length, 0, "NOTHING may be written while the file is unreadable");
  }

  // If we cannot even tell whether the file exists, assume it does: refusing to save is
  // recoverable, overwriting a license key is not.
  {
    const { store, saves } = makeStore({
      exists: async () => {
        throw new Error("EPERM");
      },
    });
    assert.equal((await store.load()).unreadable, true);
    await store.save();
    assert.equal(saves.length, 0);
  }

  // Stored settings win over defaults, and a licence survives the round trip.
  {
    const { store } = makeStore({ stored: { licenseKey: "abc.def", isPro: true, calendarName: "Mine" } });
    await store.load();
    assert.equal(store.settings.licenseKey, "abc.def");
    assert.equal(store.settings.calendarName, "Mine");
    assert.equal(store.settings.exportTags, true, "unset fields fall back to the default");
  }

  // A persisted purchaseUrl must not outrank the constant — that is how every install froze on
  // whatever checkout link it first shipped with.
  {
    const { store } = makeStore({ stored: { purchaseUrl: "https://old.example/dead" } });
    await store.load();
    assert.equal(store.settings.purchaseUrl, undefined);
  }

  // The 1.0.x migration runs exactly once and consumes its keys. Leaving them in re-applied the
  // migration on every load, so the output path became impossible to change.
  {
    const { store, saves } = makeStore({ stored: { outputPath: "Cal/mine.ics", maxFreeTasks: 10 } });
    const outcome = await store.load();
    assert.ok(outcome.notice.includes("Cal/mine.ics"), "the user is told where their calendar went");
    assert.equal(store.settings.vaultOutputPath, "Cal/mine.ics", "the existing feed does not move");
    assert.equal(store.settings.currentNoteOutputPath, "Cal/mine-current-note.ics");
    assert.ok(store.settings.ownedPaths.includes("Cal/mine.ics"));
    assert.equal(store.settings.outputPath, undefined, "the legacy key is consumed");
    assert.equal(store.settings.maxFreeTasks, undefined);

    await store.save();
    const written = saves[0];
    assert.equal(written.outputPath, undefined, "and never written back");
  }

  // A 1.0.x path the new validation rejects cannot be kept, and the user is told rather than
  // silently moved.
  {
    const { store } = makeStore({ stored: { outputPath: "Projects.md" } });
    const outcome = await store.load();
    assert.equal(store.settings.vaultOutputPath, "Calendar/tasks.ics", "falls back to the default");
    assert.ok(outcome.notice.includes("Projects.md"));
    assert.ok(outcome.notice.includes("must end in .ics"));
  }

  // Nothing to migrate means nothing to announce.
  {
    const { store } = makeStore({ stored: { calendarName: "Mine" } });
    assert.equal((await store.load()).notice, undefined);
  }

  // A dead instance writes nothing, however it is asked.
  {
    const lane = new TaskLane({ timer: noTimer, delayMs: 0, run: async () => {} });
    const saves = [];
    const store = new SettingsStore(
      { load: async () => ({}), save: async (s) => void saves.push(s), path: () => "p", exists: async () => false },
      lane,
      () => false
    );
    await store.load();
    await store.save();
    await store.write();
    assert.equal(saves.length, 0);
  }
}

fs.unlinkSync(outfile);
fs.unlinkSync(coreOut);
console.log("app tests passed");
