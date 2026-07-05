# Changelog

All notable changes to Task Calendar Bridge are documented here. This project
follows [Semantic Versioning](https://semver.org/).

## [1.0.3] - 2026-07-05

### Internal
- **`npm run lint` now runs `eslint-plugin-obsidianmd` — the exact ruleset
  Obsidian's automated community-plugin review uses** — as a hard gate
  (`eslint . --max-warnings 0`), so review failures are caught locally before a
  release instead of after (a failed review delists the plugin). Added a
  **manifest-contract test** and a reusable **release checklist** in `docs/`. No
  source changes were needed — the code already met the review rules.
