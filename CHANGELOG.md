# Changelog

All notable changes to Task Calendar Bridge are documented here. This project
follows [Semantic Versioning](https://semver.org/).

## [1.2.1] - 2026-08-05

Two fixes that only became visible once the plugin's internals were pulled apart
and put under test. Nothing about your calendar's contents changes: the exported
file is byte-for-byte what 1.2.0 produced, and event identity is untouched.

### Fixed

- **A settings change that fails to save now tells you.** Every text field in the
  settings tab — the calendar name, both output paths, the time zone, the publish
  folder — saves a moment after you stop typing. If that write failed, which a
  vault inside a cloud folder can cause, nothing was reported: no notice, no
  entry anywhere, and the setting quietly reverted the next time Obsidian
  started. The failure now says so.
- **Removing your licence while an automatic export was already queued no longer
  truncates the calendar.** The check for whether auto-export is allowed happened
  when the export was scheduled rather than when it ran, so an export queued
  moments earlier still went ahead — and took the free-tier path, replacing a
  full calendar with the next 25 tasks. It is now checked at the moment the
  export actually starts, and a lapsed licence stops it.

### Internal

- The plugin layer had no tests at all: 1,877 lines covering the export
  pipeline, the file writer, scheduling and settings persistence, none of it
  reachable by a test because the `obsidian` package ships type definitions with
  no runtime. That code now lives behind a seam that imports nothing from
  Obsidian, so the same test setup that has always covered the parser covers it
  too — and a guard test keeps it that way.
- The export is a pure function of its inputs, the two write destinations share
  one implementation instead of two copies of the same rule, and the five
  separate debouncers, queues and flags that had accumulated around scheduling
  are one thing.
- `main.ts` is 595 lines, down from 846, and stopped growing for the first time
  in three releases.
- Continuous integration exists, on Node 20 and 22.

## [1.2.0] - 2026-08-04

The hardening release. Three rounds of adversarial review over 1.1.0 turned up
several ways a task could vanish from your calendar without a word, a way a paid
license key could be destroyed, and a fixed time zone that was not actually
fixed. All of it is fixed here, for free and Pro users alike.

Event identity is unchanged, so a calendar you have already imported or
subscribed to keeps updating in place — with one exception. Tasks tagged in a
non-ASCII script had part of the tag stuck in their title, and fixing that
changes the title, which is part of how an event is identified. Those specific
events arrive as new ones; a subscribed calendar sorts itself out on the next
refresh, and an imported one needs the old copies deleted once.

### Fixed — tasks that silently disappeared

- **A code fence inside a callout no longer swallows the rest of your note.**
  Closing a callout's code block without the leading `>` — a constant slip — left
  the fence open, hunting for a matching close arbitrarily far down the note.
  Every real dated task in between was treated as sample code and left out of the
  calendar, with **nothing in the export report** to say where they had gone.
- **A typo in a date that is not placing the event no longer deletes the task.** A
  task carrying both a scheduled date and a due date lost the whole event to one
  fat-fingered deadline, even though the scheduled date that actually places it
  was perfectly good. The unusable field is dropped and reported; the event stays.
- **Tags work in every language.** The tag rule was ASCII-only, so `#café`
  exported as the tag `caf` and left a stray `é` sitting in the calendar event's
  title, while `#仕事` and `#работа` did not register at all and stayed in the
  title whole. Any Unicode letter now works, along with emoji tags and decomposed
  accents.
- **A 🛫 start date is no longer lost** when the same task also carries a
  `[start:: HH:mm]` time — and a task whose only date was that one no longer
  disappears as undated.
- **An alarm the free tier cannot set is now reported.** A `[reminder:: 30m]` used
  to vanish silently while the report said nothing had been skipped.

### Fixed — your data

- **An unreadable settings file can no longer destroy your Pro license key.** A
  force-quit mid-save, a cloud-sync conflict, or a file the OS still had open all
  looked exactly like a first run, and the plugin wrote its defaults straight over
  the top — taking with them the only copy of the key you paid for. It now refuses
  to write anything, says so, and tells you where the file is.
- **An older export can no longer overwrite a newer one.** Only the final write
  was serialised, so a slow export that started first could finish last, put a
  stale calendar on disk, and overwrite the newer run's report with it. The whole
  pipeline is serialised now, and rapid edits coalesce into one trailing run.
- **The published copy is written atomically** — to a temporary file, then renamed
  over the target — so a calendar app polling it or a cloud client syncing it can
  never read a half-written file, and an interrupted write no longer destroys the
  last good one.
- **Losing Pro no longer silently adds notes to your calendar.** Exclude-folder
  filters were skipped entirely without a license, so removing one put every task
  in Archive and Templates into the export. Exclusions now always apply.
- **Publishing that has stopped now says so.** With Pro removed it became a silent
  no-op, while the copy other people had subscribed to stayed frozen indefinitely.

### Fixed — calendar correctness

- **A fixed time zone is now actually fixed.** Repeating timed events were emitted
  as floating local time with no zone attached, so a weekly 09:00 New York standup
  showed at 09:00 wherever the viewer happened to be. Every timed event now
  carries `TZID` and the file carries a real `VTIMEZONE`, generated from the
  time-zone rules your device already has — which also means a 09:00 meeting stays
  at 09:00 across a DST change instead of sliding to 08:00. Half-hour and
  45-minute zones, zones whose DST step is 30 minutes, and southern-hemisphere
  zones are all handled.
- **A repeat rule containing a word the plugin does not understand is rejected
  rather than guessed at.** `every week on Monday, Funday` quietly became a
  Monday-only schedule — a rule meaning something different from what you wrote,
  with nothing on screen to say so.
- **A task dated the year 9999 no longer produces an invalid file.** Its exclusive
  end date rolled into a nine-digit year, which is not a legal calendar date and
  voided the entire export.

### Added

- **More repeat rules**: `every other week`, `every fortnight`, `every Monday and
  Friday`, `every Tuesdays`, `every month on the first Monday`, `every month on
  the last Friday`, and ordinal weekdays generally. The setup guide lists exactly
  what is understood, and that list is now checked against the parser by a test.
- **Link events back to their note** is now a setting. The exported file contains
  your vault's name, each note's path, and line numbers; turning this off leaves
  them out, which matters if you publish the calendar to a URL. The guide says so.
- **A first-run notice**, so enabling the plugin no longer produces no visible
  sign that anything happened at all.
- **A legible export report.** Tasks that did not reach the calendar are separated
  from tasks exported with one field ignored, and from tasks excluded on purpose
  by a setting — a vault with 400 completed tasks used to report "Skipped (401)"
  after a completely healthy export. Every row links to the line it came from, and
  an id collision now names the tasks that collided instead of only counting them.
- **The status bar and settings show when the last export ran**, so "is my
  calendar up to date?" is answerable from inside the plugin.
- **Subscribe instructions that work.** The guide told you to take the share link
  from Dropbox, iCloud Drive, or OneDrive; none of those is a link a calendar app
  can read. It now gives the URL form that actually works for each, and says
  outright that iCloud Drive cannot do it. The Outlook steps cover new Outlook,
  not only the classic File menu.

### Changed

- Generating a calendar is roughly twenty times faster on a large vault, and the
  parse cache no longer holds a second copy of every note's text in memory.
- An export that produces an identical calendar no longer rewrites the file, so an
  editing session stops churning your sync client and everyone subscribed to it.
- Editing a note in an excluded folder no longer triggers a whole-vault export.
- Settings are written on a short debounce instead of once per keystroke.
- Invalid values in the duration and reminder-time fields are reported inline
  instead of being silently replaced while the field still showed what you typed.
- A license key that fails to verify stays in the field so you can repair it, and
  activating Pro now points out that auto-export and publishing are still off.
- Publishing is shown as unavailable on mobile rather than offered and then
  failing at export time.
- Errors in the settings tab are announced to screen readers, and each "Get Pro"
  button says what it unlocks.

### Internal

- `npm test` runs on a fresh clone: the license round-trip skips itself when the
  private signing key is absent instead of taking the whole suite down with it,
  and the manifest/release gate runs first so it can never be skipped.
- Added coverage for ICS escaping, line folding over real generator output,
  `VTIMEZONE` across ten zones, Unicode tags, the fence and date-degradation
  fixes, the recurrence grammar, and the sample note — which is now parsed rather
  than grepped for substrings.
- A pinned UID corpus. Event identity is derived from the cleaned task title, so
  any change to title cleaning silently re-identifies events and puts a duplicate
  in every calendar anyone has imported. The suite now fails on that rather than
  letting it ship unnoticed.

## [1.1.0] - 2026-08-01

The correctness release. Several defects meant an ordinary day of editing could
corrupt your calendar, so those are fixed for **every** user — free and Pro.
Nothing that was free has been taken away.

### Fixed — data safety

- **Editing a note no longer duplicates calendar events.** Event UIDs used to
  include the line number, the note path, the title, and the due date, so
  inserting a line above a task, renaming a note, fixing a typo, or — worst of
  all — **rescheduling a task** gave it a brand-new identity. Re-importing then
  added a second event and orphaned the first. Identity now comes from an
  explicit `[id:: …]`, an Obsidian block id (`^abc123`), or a hash that excludes
  the line number and the date, so edits update the event in place. The hash is
  also 64-bit now; the old 32-bit one could collide in a large vault.
- **A typo in the output path can no longer destroy a note.** The path is
  validated (it must end in `.ics`, stay inside the vault, and contain no
  illegal characters) and the plugin refuses to overwrite any file it did not
  create.
- **Exporting one note no longer wipes your whole-vault calendar.** The two
  scopes write to two different files. Your existing output path is kept as the
  vault calendar, so an already-imported feed does not move.
- **Failed exports are no longer silent.** Every export is wrapped in error
  handling, failures raise a notice, and the last result is shown in settings
  and in the status bar.
- **Auto-export no longer keeps running after the plugin is disabled**, and no
  longer re-reads the entire vault on every keystroke pause — parsed notes are
  cached and only changed files are re-read. An export already in flight when
  the plugin is disabled now stops instead of writing files and overwriting the
  settings of a freshly loaded instance.
- **A mistyped license key can no longer destroy a working one.** The key is
  verified before it is stored, so an unverifiable paste leaves your active
  license untouched and just shows the error.
- **A failed publish no longer reports the whole export as failed** when the
  calendar file was written correctly.
- The two output paths cannot be set to the same file, compared the way the
  filesystem compares them rather than case-sensitively.
- **Removing a license is now a deliberate act.** Emptying the field and
  clicking away used to erase the plugin's only copy of your key.
- A publish failure is recorded and shown in settings, so a Pro user whose
  publish target breaks finds out instead of quietly serving a stale calendar.
- The export report survives a restart — the moment a user notices tasks missing
  from their calendar is exactly when it used to be gone.
- A repeat rule that does nothing because the setting is off now says so in the
  report, instead of the report claiming nothing was skipped.
- The export notice separates tasks that did not reach the calendar from tasks
  that exported with one field ignored, and no longer shows a stale report from
  the previous successful run after a failure.

### Fixed — calendar correctness

- **Every "Source" link in an exported event was dead.** The old
  `obsidian://open?path=…#L5` form is not a valid Obsidian URI. Events now carry
  a working `obsidian://open?vault=…&file=…` link in both `DESCRIPTION` and the
  `URL` property.
- **`STATUS:COMPLETED` is not legal in a `VEVENT`** (it is a `VTODO` value), so
  the Pro "include completed tasks" feature was producing invalid files.
  Completed tasks now use `STATUS:CONFIRMED`, an `X-OBSIDIAN-TASK-COMPLETED`
  flag, a `Completed` category, and a ✔ in the title.
- **All-day tasks no longer mark your entire day as busy** (`TRANSP:TRANSPARENT`).
- **Alarms on all-day tasks no longer fire at 23:30 the night before.** There is
  a new "All-day reminder time" setting, defaulting to 09:00.
- **`METHOD:PUBLISH` removed** — it declares an iTIP scheduling message that
  requires an `ORGANIZER` this calendar has no business inventing.
- **A task with both a start time and an end date no longer loses the end date.**
- Invalid dates and times never reach the file. `2026-99-99` and `29:75` used to
  pass straight through and could make a calendar app refuse the entire import.
  A bad *placement* date skips the task; a bad *decoration* drops that field and
  the task still exports. Either way it is listed in the report.

### Fixed — parsing

- **Writing the same task on successive days now produces one event per day.**
  The same title on different dates collapsed onto a single identity, so all but
  the first `Standup` silently vanished from the calendar.
- **A malformed decoration no longer deletes the whole task.** An unreadable
  start time, end date, or duration is dropped and reported; the task still
  exports on its valid date. `due:: 2026-08-02 #work` — a bare field followed by
  a tag, a block id, or ordinary prose — exports again too.
- Tasks written **inside code fences are no longer exported** as real events.
- **Code fences are matched properly**: a ``` line no longer closes a ````
  block, a `~~~` line no longer closes a ``` block, and an unterminated fence no
  longer hides every task below it.
- **A repeat rule that disagrees with the task's date is reported instead of
  exported** — `every month on the 15th` on a task dated the 3rd means different
  things in different calendar apps.
- A single pathological line no longer freezes the editor during export: task
  lines over 2 000 characters are reported and skipped.
- Durations over a year, `1,5h` (European decimal), and two-digit years are all
  handled instead of producing corrupt output.
- **Completing one of several same-titled tasks no longer rewrites the identity
  of the others**, which would have orphaned their calendar events.
- A code fence inside a callout stays inside the callout; it can no longer be
  closed by an unrelated fence elsewhere in the note.
- `every month on the last` is now checked against the task's date like every
  other repeat rule.
- Dataview links with a folder or an alias — `[due:: [[Daily/2026-08-02|Aug 2]]]`
  — are understood.
- **A trailing tag, block id, or parenthetical no longer eats the field it
  follows.** `duration:: 45m (about an hour)` and `🔁 every week on Monday #work`
  both work; the second used to quietly downgrade a Pro repeating event to a
  single one.
- A field value that collides with a JavaScript object member — `[priority::
  constructor]`, `[repeat:: every constructor]` — can no longer write a function
  body into the calendar file and make it unparseable.
- Control characters pasted into a task title are stripped instead of making the
  whole file unimportable.
- Tasks in **callouts, blockquotes, and numbered lists are now exported** — they
  used to be invisible.
- **Custom checkbox states are recognised**: `[/]` in progress, `[-]` cancelled
  (exported as `STATUS:CANCELLED` with Pro), and unknown states treated as open.
- The tag stripper no longer eats **issue numbers (`#123`)** or headings inside
  a wikilink.
- Bare `duration:: 1 hour` no longer truncates at the first space and becomes a
  one-minute event. `1h30m`, `45`, `1.5h`, and `2 days` all work; anything not
  understood is reported rather than guessed at.
- `9:30` and `09:30:00` are accepted, not silently downgraded to an all-day event.
- Dataview date links (`[due:: [[2026-08-02]]]`) are understood.
- Wikilinks, markdown links, bold, and code spans render as readable text in the
  event title.

### Added — free

- **Obsidian Tasks syntax support**: `📅 📆 🗓` due, `⏳` scheduled, `🛫` start,
  `✅` done, `➕` created, `🆔` id, and the `🔺 ⏫ 🔼 🔽 ⏬` priority emoji. A
  scheduled date places the event; the due date is carried as the deadline.
  None of these leak into the calendar title any more.
- **Tags become calendar categories**, so you can colour and filter by them.
- **Priority becomes calendar priority.**
- **Time zone handling.** Keep local wall time (the previous behaviour), or pin
  events to a fixed IANA zone so they stay correct when you travel. DST is
  handled without shipping timezone rules that go stale: a wall time inside a
  spring-forward gap shifts forward (in every zone, east or west of UTC), an
  ambiguous fall-back time takes the earlier of its two instants, and repeating
  events stay on wall-clock time so they do not drift an hour when the clocks
  change. Half-hour and 45-minute offsets are handled.
- **12-hour times.** `[start:: 7:00 pm]` and `7pm` work. Previously the bare
  form was cut at the space and a 7 PM dinner was exported at 7 AM.
- **An export report** — "Show last export report" lists every skipped task and
  why: no date, invalid date, an untranslatable repeat rule, or the free cap.
  Undated tasks used to vanish with no explanation at all.
- **The free cap now exports the next 25 _upcoming_ tasks**, sorted by date,
  instead of whichever 25 the vault happened to list first. The cap is no longer
  an editable number in `data.json`.
- Timed events, durations, and multi-day events are documented as free, which is
  what the code has always done.
- A status bar item showing the last export.

### Added — Pro

- **Repeating events.** A `🔁 every 2 weeks on Monday` rule becomes a real
  recurring calendar event (`RRULE`) instead of a single one-off. Rules that
  cannot be translated are reported, never guessed at.
- **Publish outside the vault** (desktop). Write a copy of the calendar into a
  folder your cloud drive syncs, then **subscribe** to its URL in your calendar
  app instead of re-importing by hand. With auto-export on, the calendar keeps
  itself current — the live-calendar workflow the old README could only gesture at.
- Cancelled tasks export as cancelled events.
- Folder filters now match on path boundaries: `Work` no longer also selects
  `Workshop`.

### Changed

- Default output paths are `Calendar/tasks.ics` and `Calendar/current-note.ics`.
  The old `.task-calendar-bridge/` folder was hidden from the file explorer and
  skipped by sync. **Existing installs keep their configured path** for the
  whole-vault calendar, and the current-note file is placed beside it — the
  ribbon icon writes there, so pointing it at a brand-new default would have
  left an already-subscribed feed frozen. A one-time notice explains the change.
- The license key is verified when you press **Activate**, Enter, or leave the
  field — not on every keystroke, which used to rebuild the settings tab and
  steal your cursor mid-paste. Verification errors are now shown.
- Locked Pro settings have a working **Get Pro** button instead of being dead rows.
- Repeating events and reminder alarms are **on by default once Pro is active**.
  Shipping them off made features the README sells look broken.
- Completed and cancelled tasks are no longer counted as "skipped" in the export
  notice; they are excluded on purpose, and counting them made a normal export
  read like a failure.

## [1.0.3] - 2026-07-05

### Internal
- **`npm run lint` now runs `eslint-plugin-obsidianmd` — the exact ruleset
  Obsidian's automated community-plugin review uses** — as a hard gate
  (`eslint . --max-warnings 0`), so review failures are caught locally before a
  release instead of after (a failed review delists the plugin). Added a
  **manifest-contract test** and a reusable **release checklist** in `docs/`. No
  source changes were needed — the code already met the review rules.
