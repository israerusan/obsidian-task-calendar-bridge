# Release checklist

## Before release

- [ ] Run `npm test`
- [ ] Run `npm run build`
- [ ] Confirm `main.js`, `manifest.json`, and `styles.css` exist
- [ ] Rebuild `dist/task-calendar-bridge-0.1.0.zip`
- [ ] Install into a clean test vault
- [ ] Run `Create sample task note`
- [ ] Run current-note export
- [ ] Import `.task-calendar-bridge/tasks.ics` into at least one calendar app
- [ ] Test a Pro key generated with `npm run license:generate -- test@example.com`
- [ ] Confirm free tier caps full-vault export at 25 tasks
- [ ] Confirm Pro removes the cap

## Store listing

- [ ] Product name: Task Calendar Bridge
- [ ] Price: $9 one-time
- [ ] Payment label: Optional payments
- [ ] Short description: Export dated Obsidian tasks to calendar-friendly ICS files.
- [ ] Mention privacy: offline export, no server, no account

## Do not publish

- [ ] `scripts/.license-private.key`
- [ ] `node_modules/`
- [ ] local test vaults or generated customer data
