# Release checklist

The authoritative, Obsidian-review-specific steps live in
[`docs/obsidian-release-checklist.md`](docs/obsidian-release-checklist.md).
This file is the short version for cutting a build.

## Before release

- [ ] Bump `manifest.json` and `package.json` to the same version
- [ ] Add that version to `versions.json` with the **current** `minAppVersion`
      (the manifest-contract test enforces both)
- [ ] Update `CHANGELOG.md`
- [ ] `npm test` — lint, manifest contract, core, help, license
- [ ] `npm run build`
- [ ] Confirm `main.js`, `manifest.json`, and `styles.css` exist
- [ ] **`git status --porcelain` is empty.** Do this before the step below, not
      after. The gate below runs against the committed tree, so an uncommitted
      fix is invisible to it — every test still passes and the release quietly
      ships the unfixed code.
- [ ] Build from a clean checkout, not the working tree, so a file that is
      imported but never committed cannot pass:
      `git archive HEAD | tar -x -C ../tcb-release-check && cd ../tcb-release-check && npm ci && npm test && npm run build`

## Verify in a real vault

- [ ] Install into a clean test vault
- [ ] Run `Create sample task note`
- [ ] Run the current-note export, then the whole-vault export
- [ ] Import `Calendar/tasks.ics` into at least one calendar app
- [ ] With **Fixed time zone** on, confirm a repeating timed event lands at the
      right local time in the calendar app (this is the VTIMEZONE path)
- [ ] Test a Pro key generated with `npm run license:generate -- test@example.com`
- [ ] Confirm free tier caps full-vault export at 25 tasks, and Pro removes it

## Release

- [ ] Tag exactly the manifest version, no `v` prefix: `git push origin <version>`
      — never `git push --tags`
- [ ] Release assets: exactly `main.js`, `manifest.json`, `styles.css`
      (attaching `versions.json` triggers an "extra unsupported files" notice)

## Do not publish

- [ ] `scripts/.license-private.key`
- [ ] `node_modules/`
- [ ] local test vaults or generated customer data
