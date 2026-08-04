# Task Calendar Bridge

Turn dated Markdown tasks into a calendar you can actually use outside Obsidian.

![Task Calendar Bridge hero: tasks written in Obsidian rendered as real calendar events](docs/assets/task-calendar-bridge-hero-v2.png)

> Hero image uses a live Obsidian note capture plus the plugin's real exported `.ics` output from the same demo state.

**Works offline** · **One-time payment** · **Unlimited future updates** · **No account**

Task Calendar Bridge turns the dated tasks you already track in Markdown into a standards-based `.ics` calendar for Google Calendar, Apple Calendar, Outlook, TickTick, and anything else that speaks ICS. Write the task once in Obsidian, export it, and see it where you actually plan time.

Best fit if you:
- plan work in Markdown but still live out of a calendar
- want a local/offline workflow instead of another sync service or account
- need task dates to show up in Google Calendar, Apple Calendar, Outlook, TickTick, or mobile widgets

## Free vs Pro at a glance

| | Free | Pro ($9 one-time) |
| --- | --- | --- |
| Current note export | Unlimited | Unlimited |
| Whole-vault export | Next 25 upcoming tasks | Full vault, no cap |
| Timed events, durations, multi-day events | Yes | Yes |
| Obsidian Tasks + Dataview syntax | Yes | Yes |
| Stable event identity | Yes | Yes |
| Repeating events | No | Yes |
| Reminder alarms | No | Yes |
| Auto-export when notes change | No | Yes |
| Publish outside the vault for calendar subscription workflows | No | Yes |
| Completed/cancelled task export | No | Yes |
| Folder filters | No | Yes |

- **Free:** prove the workflow on a real note, export the current note with no cap, and test a small whole-vault feed.
- **Pro:** make it practical for daily use — full-vault export, auto-refresh, recurring events, reminders, publish/subscription workflows, and filtering.
- **Buy once, unlock in seconds:** [Buy Task Calendar Bridge Pro](https://buymeacoffee.com/vaultspotlight/e/560210) — instant checkout, automatic key delivery, offline activation.

## Why Pro is worth paying for

Free proves the bridge works. Pro makes it stop behaving like a manual export toy.

The paid value is not "more settings." It is the difference between:

- exporting one note to test the idea
- keeping a real calendar workflow alive across your vault without babysitting it

If you live out of your calendar, the practical Pro win is:
- your full vault exports instead of only the next 25 upcoming tasks
- the file refreshes itself when notes change
- repeating tasks become real recurring events
- reminders survive the jump into calendar apps
- you can publish the calendar into Dropbox, iCloud Drive, or OneDrive and subscribe once instead of re-importing forever

That is the upgrade story: not "more features," but "this now runs like a real bridge instead of a demo."

### Premium proof to look for

The strongest Pro workflow is:
1. create or edit a dated task in Obsidian
2. export or auto-export the `.ics`
3. subscribe once from your calendar app
4. watch later edits show up without another manual import

If you only need occasional one-off exports, Free is enough. If you want your Markdown task system and your calendar to stay in sync like adults, Pro is the point.

## Why people use it

Obsidian users often plan work in Markdown but still need calendar visibility in Google Calendar, Apple Calendar, Outlook, TickTick, or mobile widgets. The usual alternatives are ugly: copy tasks by hand, maintain a brittle script, or accept some app-specific workflow that breaks the moment you switch tools.

Task Calendar Bridge keeps the workflow simple:
1. write dated tasks in normal Markdown
2. export a standards-based `.ics` calendar file
3. import it once or subscribe to it from the calendar app you already use

No hosted sync layer. No account. No "please trust our server with your planning system."

## First win in 2 minutes

1. Install the plugin.
2. Run `Create sample task note` from the command palette.
3. Run `Export current note calendar`, then import the generated `.ics` file into your calendar.

If that clicks, Pro unlocks the live version of the workflow: full-vault export, auto-export, recurring events, reminders, publish-outside-the-vault, and folder filtering.

## Task syntax

Both the Obsidian Tasks emoji vocabulary and Dataview-style inline fields work, and you can mix them:

```markdown
- [ ] Simple all-day task 📅 2026-08-01 #work
- [ ] Explicit due date [due:: 2026-08-02]
- [ ] Scheduled beats due for placement ⏳ 2026-08-04 📅 2026-08-06
- [ ] Timed call [due:: 2026-08-02] [start:: 14:15] [duration:: 1h]
- [ ] Multi-day workshop [due:: 2026-08-03] [end:: 2026-08-05]
- [ ] High-priority review ⏫ [due:: 2026-08-07]
- [ ] Weekly one-to-one [due:: 2026-08-03] 🔁 every week on Monday   (Pro)
- [ ] Reminder alarm [due:: 2026-08-02] [start:: 09:00] [reminder:: 10m]   (Pro)
```

- **Dates**: `📅 📆 🗓` due, `⏳` scheduled, `🛫` start, or `[due:: …]`, `[scheduled:: …]`. A scheduled date places the event on the calendar; the due date travels with it as the deadline. Dataview date links (`[due:: [[Daily/2026-08-02]]]`) work too.
- **Times**: `[start:: 14:15]`, `9:30`, or `7:00 pm`. `[duration:: 1h30m]`, `45`, or `1.5h`.
- **Checkbox states**: `[ ]` open, `[/]` in progress, `[x]` done, `[-]` cancelled. Done and cancelled tasks are excluded unless you turn them on (Pro).
- **Tags** on the task line become calendar categories you can colour and filter by.
- **Priority** — `🔺 ⏫ 🔼 🔽 ⏬` or `[priority:: high]` — becomes calendar priority.
- Tasks inside code fences are ignored; tasks in callouts, blockquotes, and numbered lists are exported.

**Wondering why a task is missing?** Run **Show last export report**. It lists every skipped task and the reason.

## Free features

- Export every dated task from the current note, with no cap
- Whole-vault export of the next 25 upcoming tasks
- Full Obsidian Tasks and Dataview syntax, tags as categories, priority
- Timed events, durations, and multi-day events
- Time zone handling: keep local wall time, or pin events to a fixed zone (DST handled)
- Stable event identity, so re-importing updates events instead of duplicating them
- Export report, working `obsidian://` links back to the source note
- Built-in calendar import and subscription guide, sample note generator
- Offline-first; no account or server

## Pro ($9 one-time)

- Full-vault ICS export with no cap
- Auto-export when notes change
- **Repeating events** — `🔁 every 2 weeks on Monday` becomes a real recurring event
- **Publish outside the vault** — write the calendar into a cloud-synced folder so your calendar app can *subscribe* instead of you re-importing (desktop)
- Reminder alarms via `[reminder:: 10m]`
- Include completed and cancelled tasks
- Include/exclude folder filters
- Offline Ed25519 license verification; no subscription server needed
- One purchase, no expiry, unlimited future updates

### Activate Pro

1. Purchase on [Buy Me a Coffee](https://buymeacoffee.com/vaultspotlight/e/560210).
2. Your license key arrives automatically within seconds — no waiting, no manual delivery.
3. Obsidian → **Settings → Task Calendar Bridge → License key** → paste the key and press **Activate**. Pro unlocks immediately (offline verification).

## Import once, or subscribe?

This matters more than any other setting.

**Importing** an `.ics` file copies the events in once and never looks at the file again — you have to re-import after every change. **Subscribing** points your calendar at a URL and refreshes on its own.

To subscribe, the file has to be somewhere your calendar app can reach. The Pro **Publish outside the vault** setting writes a copy into any folder you choose: put it in Dropbox, iCloud Drive, or OneDrive, take the public link, and subscribe to that. Turn on auto-export and the calendar keeps itself current.

| Calendar | Import once | Subscribe |
| --- | --- | --- |
| Google Calendar | Settings → Import & export → Import | Other calendars → + → From URL |
| Apple Calendar | File → Import | File → New Calendar Subscription |
| Outlook | File → Open & Export → Import/Export | Add calendar → Subscribe from web |
| TickTick | Calendar import | Calendar subscription settings |

Refresh intervals are set by the calendar provider, not by this plugin — Google typically refreshes every few hours, and Apple Calendar lets you choose.

## Install

**Community plugins (recommended):** open **Settings → Community plugins**, search **Task Calendar Bridge**, and install it — one click, auto-updates.

### Manual install

1. Download or build the release package.
2. Copy these files into `.obsidian/plugins/task-calendar-bridge/` inside your vault:
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. Enable **Task Calendar Bridge** in Obsidian Settings -> Community plugins.
4. Run `Create sample task note` from the command palette to test it.

## Upgrading from 1.0.x

1.1.0 changes how events are identified so that editing a note stops creating duplicate calendar entries. Because the identity scheme itself changed, **the first export after upgrading looks like a new set of events to a calendar you previously imported into.** The cleanest path is to delete the calendar you had imported and import (or subscribe to) the new file once. After that, edits update events in place.

Your configured output path is kept as the whole-vault calendar; current-note exports move to their own file so the two can no longer overwrite each other.

## Development

```bash
npm install
npm test
npm run build
```

## Pro license generation

The private signing key lives at `scripts/.license-private.key` and is ignored by git. Keep it backed up and private.

```bash
npm run license:generate -- customer@email.com
```

The generated key can be pasted into Settings -> Task Calendar Bridge -> License key.
