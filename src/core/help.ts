export const IMPORT_GUIDE_MARKDOWN = `# Task Calendar Bridge setup

The plugin writes a standards-based .ics calendar file. By default:

- Whole vault: Calendar/tasks.ics
- Current note: Calendar/current-note.ics

Run "Export vault tasks to ICS" or "Export current note tasks to ICS" first, then either import that file once or — better — subscribe to it so it keeps updating.

## Import once, or subscribe?

Importing a local file copies the events in and never looks at the file again, so you must re-import after every change. Subscribing points your calendar at a URL and refreshes on its own.

To subscribe, the file needs to be somewhere your calendar app can reach over HTTP(S). The Pro "Publish outside the vault" setting writes a copy into any folder you choose — put it inside Dropbox, iCloud Drive, OneDrive, or a folder you already serve, take the public link, and subscribe to that. Turn on auto-export and the calendar keeps itself current.

Refresh intervals are set by the calendar provider, not by this plugin. Google typically refreshes a subscribed calendar every few hours; Apple Calendar lets you choose (Calendar -> Settings -> Accounts -> Refresh).

## Google Calendar

- Import once: Settings -> Import & export -> Import, pick the .ics file, choose a target calendar.
- Subscribe: Other calendars -> + -> From URL, paste the public URL of the published file.

## Apple Calendar

- Import once: File -> Import, pick the .ics file.
- Subscribe: File -> New Calendar Subscription, paste the URL, and set the refresh interval.

## Outlook

- Import once: File -> Open & Export -> Import/Export -> Import an iCalendar (.ics) file.
- Subscribe: Add calendar -> Subscribe from web, paste the URL.

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

Tags on the task line become calendar categories. Priority emoji and [priority:: high] become calendar priority. Checked, cancelled, and in-progress checkboxes are all recognised.

## Why is a task missing?

Run "Show last export report". It lists every task that was skipped and why: no date, an invalid date, a repeat rule that could not be translated, or the free-tier cap.
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

## Statuses

- [x] Completed task, exported with Pro [due:: 2026-08-06]
- [-] Cancelled task, exported with Pro [due:: 2026-08-06]
- [/] In-progress task [due:: 2026-08-08]

## Not exported

- [ ] This task has no date, so the report lists it as skipped
`;
