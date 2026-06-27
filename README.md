# Task Calendar Bridge

Bridge Obsidian tasks into calendar apps with an offline, privacy-friendly `.ics` export.

This plugin is built as a freemium product: useful free current-note export plus a small one-time Pro unlock for vault-wide automation.

## Why it exists

Obsidian users often plan work in Markdown but still need calendar visibility in Google Calendar, Apple Calendar, Outlook, TickTick, or mobile widgets. Existing workflows usually require scripts, manual copying, or fragile app-specific integrations. Task Calendar Bridge keeps the first version simple and durable: parse dated Markdown tasks and generate a standards-based ICS calendar file.

## Free features

- Export due tasks from the current Markdown note
- Export vault tasks capped at 25 tasks
- Generate `.task-calendar-bridge/tasks.ics`
- Copy the ICS vault path
- Built-in calendar import guide
- Sample note generator with supported syntax
- Offline-first; no account or server

## Pro features ($9 one-time suggested)

- Full-vault ICS export with no free-tier cap
- Auto-export when Markdown notes change
- Include completed tasks as completed calendar events
- Reminder alarms via `[reminder:: 10m]`
- Timed events via `[start:: 14:15]` and `[duration:: 1h]`
- Include/exclude folder filters
- Offline Ed25519 license verification; no subscription server needed

## Supported task syntax

```markdown
- [ ] Simple all-day task 📅 2026-08-01
- [ ] Explicit due-date task [due:: 2026-08-02]
- [ ] Timed call [due:: 2026-08-02] [start:: 14:15] [duration:: 1h]
- [ ] Reminder alarm [due:: 2026-08-02] [start:: 14:15] [reminder:: 10m]
- [ ] Multi-day workshop [due:: 2026-08-03] [end:: 2026-08-05]
```

Completed tasks are skipped by default. Pro users can include them.

## Calendar import notes

The plugin generates a local ICS file. Most calendar apps treat ICS import as a one-time import rather than a live subscription when the file is local. The recommended v1 workflow is:

1. Run `Task Calendar Bridge: Export current note tasks to ICS` or `Task Calendar Bridge: Export vault tasks to ICS`.
2. Import `.task-calendar-bridge/tasks.ics` into your calendar app.
3. Re-export and re-import when tasks change, or use Pro auto-export with a synced folder workflow.

The in-plugin guide covers Google Calendar, Apple Calendar, Outlook, and TickTick.

## Manual install

1. Download or build the release package.
2. Copy these files into `.obsidian/plugins/task-calendar-bridge/` inside your vault:
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. Enable **Task Calendar Bridge** in Obsidian Settings -> Community plugins.
4. Run `Create sample task note` from the command palette to test it.

## Development

```bash
npm install
npm test
npm run build
```

## Packaging

Release zip output:

```text
dist/task-calendar-bridge-1.0.1.zip
```

## Pro license generation

The private signing key lives at `scripts/.license-private.key` and is ignored by git. Keep it backed up and private.

```bash
npm run license:generate -- customer@email.com
```

The generated key can be pasted into Settings -> Task Calendar Bridge -> License key.

## Suggested sales copy

Task Calendar Bridge turns dated Obsidian tasks into calendar events without sending your notes to a server. Keep planning in Markdown, then export clean ICS files for Google Calendar, Apple Calendar, Outlook, TickTick, and more.

Suggested price: $9 one-time for Pro.
