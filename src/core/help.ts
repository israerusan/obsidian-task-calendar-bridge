export const IMPORT_GUIDE_MARKDOWN = `# Task Calendar Bridge setup

Task Calendar Bridge writes a local ICS file in your vault, by default:

.task-calendar-bridge/tasks.ics

Use the command "Export current note tasks to ICS" or "Export vault tasks to ICS" first, then import the generated file into your calendar app.

## Google Calendar

Google Calendar can import an ICS file from Settings -> Import & export -> Import. Select the generated .ics file and choose a target calendar. Google import is usually a one-time import; re-import after exporting again if you want updates.

## Apple Calendar

Open Apple Calendar and use File -> Import. Pick the generated .ics file. For repeat updates, re-import after export or use a synced folder workflow.

## Outlook

Use File -> Open & Export -> Import/Export -> Import an iCalendar (.ics) file, then choose the generated .ics file.

## TickTick

Use TickTick's calendar/import options where available, or import the generated .ics into the calendar account that TickTick displays.

## Supported task syntax

- [ ] Simple all-day task 📅 2026-08-01
- [ ] Explicit due date [due:: 2026-08-02]
- [ ] Timed task [due:: 2026-08-02] [start:: 14:15] [duration:: 1h]
- [ ] Reminder alarm [due:: 2026-08-02] [start:: 14:15] [reminder:: 10m]
- [ ] Multi-day task [due:: 2026-08-03] [end:: 2026-08-05]
`;

export const SAMPLE_TASK_NOTE = `# Task Calendar Bridge Sample

Try running "Task Calendar Bridge: Export current note tasks to ICS" from the command palette.

- [ ] Simple all-day task 📅 2026-08-01 #calendar
- [ ] Explicit due-date task [due:: 2026-08-02]
- [ ] Timed call [due:: 2026-08-02] [start:: 14:15] [duration:: 1h] [reminder:: 10m]
- [ ] Multi-day workshop [due:: 2026-08-03] [end:: 2026-08-05]
- [x] Completed task [due:: 2026-08-06]
- [ ] This task has no due date and will not be exported
`;
