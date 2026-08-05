export const IMPORT_GUIDE_MARKDOWN = `# Task Calendar Bridge setup

The plugin writes a standards-based .ics calendar file. By default the whole vault goes to Calendar/tasks.ics and the current note to Calendar/current-note.ics.

Run "Export vault tasks to ICS" or "Export current note tasks to ICS" first, then either import that file once or — better — subscribe to it so it keeps updating.

## Import once, or subscribe?

Importing a local file copies the events in and never looks at the file again, so you must re-import after every change. Subscribing points your calendar at a URL and refreshes on its own.

To subscribe, the file has to be reachable over HTTP(S) and it has to come back as the file itself, not as a web page. This is where most setups go wrong: the ordinary "share" link from a cloud drive opens a preview page, and a calendar app fed that link reports that it could not read the calendar.

Refresh intervals are set by the calendar provider, not by this plugin. Google refreshes a subscribed calendar on its own schedule, often only every several hours and sometimes longer; Apple Calendar lets you choose the interval yourself (Calendar -> Settings -> Accounts -> Refresh). Neither refreshes on demand, so a subscribed calendar is always a little behind the file.

## Turning a published file into a link you can subscribe to

The Pro "Publish outside the vault" setting writes a copy of the calendar into any folder you choose. Put that folder inside a service that can serve the raw file:

- Dropbox: share the file, then change the end of the link from ?dl=0 to ?raw=1. The ?dl=0 form is a preview page and will not work.
- OneDrive: share the file, then add ?download=1 to the end of the link.
- Any static host you already run, or a GitHub Gist raw URL: use the direct file URL as-is.
- iCloud Drive cannot do this. Its share links are web viewer pages with no direct file URL, so use one of the options above instead.

Turn on auto-export as well, and the published file — and so the calendar people subscribe to — keeps itself current.

Before you publish, know what is in the file. Every event carries its task title, its tags, the vault-relative path and line number of the note it came from, and your vault's name in a link back to it. That is what makes the calendar useful, and it is more than you may want on a public URL. Publish to an unguessable or access-controlled link rather than a listed one, or turn off "Link events back to their note" in settings to leave the paths and the vault name out.

## Google Calendar

- Import once: Settings -> Import & export -> Import, pick the .ics file, choose a target calendar.
- Subscribe: Other calendars -> + -> From URL, paste the direct URL of the published file.

## Apple Calendar

- Import once: File -> Import, pick the .ics file.
- Subscribe: File -> New Calendar Subscription, paste the URL, and set the refresh interval.

## Outlook

- New Outlook and Outlook on the web: Calendar -> Add calendar -> Upload from file to import once, or Subscribe from web to subscribe to a URL.
- Classic Outlook for Windows: File -> Open & Export -> Import/Export -> Import an iCalendar (.ics) file.

## TickTick

Use TickTick's calendar subscription settings, or subscribe from the calendar account TickTick already displays.

## Supported task syntax

Dates can be written as Obsidian Tasks emoji or as inline fields:

- [ ] All-day task with a due date 📅 2026-08-01
- [ ] Explicit due date [due:: 2026-08-02]
- [ ] Scheduled date wins over due for calendar placement [scheduled:: 2026-08-02] [due:: 2026-08-05]
- [ ] Timed task [due:: 2026-08-02] [start:: 14:15] [duration:: 1h]
- [ ] Reminder alarm (Pro) [due:: 2026-08-02] [start:: 14:15] [reminder:: 10m]
- [ ] Multi-day task [due:: 2026-08-03] [end:: 2026-08-05]
- [ ] Repeating task (Pro) [due:: 2026-08-03] [repeat:: every 2 weeks on Monday]

Tags on the task line become calendar categories, in any language. Priority emoji and [priority:: high] become calendar priority. Checked, cancelled, and in-progress checkboxes are all recognised.

## Repeat rules that are understood

Repeat rules are translated into a real calendar recurrence. A rule that cannot be translated exactly is reported instead of guessed at, and the task is exported as a single event. These all work:

- every day / every 3 days
- every week / every 2 weeks / every other week / every fortnight
- every Monday / every Monday and Friday / every week on Monday, Friday
- every weekday
- every month / every 2 months
- every month on the 15th / every month on the last
- every month on the first Monday / every month on the last Friday
- every year

The date on the task has to agree with the rule: "every week on Monday" on a task dated a Thursday is reported rather than exported, because calendar apps disagree about what that means.

## Why is a task missing?

Run "Show last export report". It separates tasks that did not reach the calendar at all from tasks that were exported with one field ignored, and from tasks excluded on purpose by your settings. Each entry links straight to the line it came from.
`;

export const SAMPLE_TASK_NOTE = `# Task Calendar Bridge Sample

Run "Task Calendar Bridge: Export current note tasks to ICS" from the command palette, then "Show last export report" to see what happened.

## Dates

- [ ] Simple all-day task 📅 2026-08-01 #calendar
- [ ] Explicit due-date task [due:: 2026-08-02]
- [ ] Scheduled beats due for placement ⏳ 2026-08-04 📅 2026-08-06
- [ ] Multi-day workshop [due:: 2026-08-03] [end:: 2026-08-05] #work

## Times

- [ ] Timed call [due:: 2026-08-02] [start:: 14:15] [duration:: 1h]
- [ ] Reminder alarm, Pro [due:: 2026-08-02] [start:: 09:00] [reminder:: 10m]

## Priority and repeats

- [ ] High-priority review ⏫ [due:: 2026-08-07]
- [ ] Weekly one-to-one, Pro [due:: 2026-08-03] 🔁 every week on Monday
- [ ] Fortnightly planning, Pro [due:: 2026-08-07] 🔁 every other Friday
- [ ] Monthly board meeting, Pro [due:: 2026-08-03] 🔁 every month on the first Monday

## Statuses

- [x] Completed task, exported with Pro [due:: 2026-08-06]
- [-] Cancelled task, exported with Pro [due:: 2026-08-06]
- [/] In-progress task [due:: 2026-08-08]

## Stable identity

Give a task a block id or an explicit id and its calendar event keeps that identity through any edit, including a rename of this note.

- [ ] Task with a block id [due:: 2026-08-09] ^sample-block
- [ ] Task with an explicit id [due:: 2026-08-10] [id:: sample-task]

## Not exported

- [ ] This task has no date, so the report lists it as skipped
`;
