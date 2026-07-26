# Task Calendar Bridge

> See your Obsidian tasks in Google Calendar, Apple Calendar, Outlook, or TickTick — without sending a single note to the cloud.

Plan your work in Markdown, then export your dated tasks as a standards-based `.ics` calendar file that any calendar app can import. It runs entirely offline: no account, no server, no third-party sync. The current-note export is free forever; a one-time Pro unlock adds full-vault automation.

<!-- SCREENSHOT SLOT — drop a real capture here to lift conversions.
     ![Obsidian tasks exported and showing up as events in Google Calendar](docs/assets/hero.png)
     Suggested shot: split view — a Markdown note with dated tasks on the left, the same items as calendar events on the right. Save as docs/assets/hero.png -->


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

## Pro ($9 one-time)

- Full-vault ICS export with no free-tier cap
- Auto-export when Markdown notes change
- Include completed tasks as completed calendar events
- Reminder alarms via `[reminder:: 10m]`
- Timed events via `[start:: 14:15]` and `[duration:: 1h]`
- Include/exclude folder filters
- Offline Ed25519 license verification; no subscription server needed

Purchase: [Buy Me a Coffee — Task Calendar Bridge Pro](https://buymeacoffee.com/vaultspotlight/e/560210). License keys are verified **offline** (Ed25519) — no account, server, or subscription.

### Activate Pro

1. Purchase on [Buy Me a Coffee](https://buymeacoffee.com/vaultspotlight/e/560210).
2. Your license key is emailed to you **automatically, within seconds** — delivery is fully automated, no waiting.
3. Obsidian → **Settings → Task Calendar Bridge → License key** → paste the key. Pro unlocks immediately (offline verification).

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
