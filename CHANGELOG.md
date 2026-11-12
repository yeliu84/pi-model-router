# Changelog

All notable changes to `@yeliu84/pi-model-router` are documented in this file.

## [0.5.5] - 2026-11-11

### Added

- Support and documentation for GitHub Copilot's native classifier model (`github-copilot/microsoft-decision-1`, added in Pi `1.5.1`).
- Session budget cost accounting for `compaction`, `branch_summary`, and out-of-turn `usage` session entries (aligning `maxSessionBudget` with Pi's session cost totals), while preventing non-router turns/compactions from leaking into router spend.
- Package `CHANGELOG.md` for Pi `1.5.0`+ Extension Updates notifications on `pi update --extensions`.

### Changed

- Avoided appending redundant `pi.virtual-model-state` session entries when a routed request preserves the existing virtual router state (such as consecutive tool-result continuations or unchanged pinned turns).
- Updated development and peer-tested Pi packages to `1.5.2`, `oxfmt` to `^0.78.0`, and `vitest` to `^5.1.0`.

## [0.5.4] - 2026-10-26

### Added

- `autoPinFirstTurnDecision` configuration option to automatically pin the active profile to the tier selected on the first turn of a conversation (`#28`).

### Fixed

- Preserved working fallback models across same-tier user turns and rotated consecutive retry candidates cleanly (`#28`).
- Kept Pi's thinking level display synchronized during routing without triggering self-echo thinking overrides (`#29`).

## [0.5.3] - 2026-10-26

### Changed

- Simplified virtual model and classifier integration for Pi `1.4.0` native `registerVirtualModel` and `classify` APIs.
- Deduplicated persisted state snapshots, model lookups, thinking overrides, and cost formatting.

## [0.5.2] - 2026-10-19

### Changed

- Migrated to Pi's native virtual models (`pi.registerVirtualModel` / `pi.unregisterVirtualModel`) and native classifier models (`ctx.modelRegistry.classify`).
- Improved thinking level clamping and dynamic model registry capability resolution.

## [0.5.1] - 2026-10-14

### Fixed

- Ignored `thinking_level_select` events emitted during internal model switches (`#27`).
- Accepted headers-only authentication and merged custom headers from `models.json` for routed models (`#23`, `#26`).
- Refreshed virtual model capabilities on `turn_start` for dynamically registered local models such as `/llama` (`#24`).
- Delegated to custom provider `streamSimple` handlers when available (`#19`, `#21`).

## [0.5.0] - 2026-10-14

### Added

- Resolved supported thinking levels dynamically from Pi's runtime `modelRegistry` (including `max`).
