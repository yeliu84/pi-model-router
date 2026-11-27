# Changelog

All notable changes to `@yeliu84/pi-model-router` are documented in this file.

## [0.5.8] - 2026-11-27

### Added

- Interactive `ctx.ui.select()` tier picker (`blockedKind: 'question'`) when running `/router fix` without arguments in UI-capable sessions.
- Vision-aware candidate selection and cross-provider fallback for `"classifierModel": "auto"` across configured native decision providers (including built-in Radius `pi-decision` classifiers in Pi `1.7.0`).

### Changed

- Updated peer-tested Pi packages to `1.7.0` and documented `--agent-dir` / `PI_CODING_AGENT_DIR` global configuration resolution.
- Optimized heuristic routing hot paths and stabilized continuation state reasoning across fallback chains to avoid nested `(Original: ...)` growth and redundant session state entries.

### Fixed

- Preserved in-flight physical model cooldown tracking (`inFlightModelRef`) across `direct` summarization requests and Pi's pre-request threshold auto-compaction inside `prepareRequest`, and cleared stale in-flight state on `agent_end`.
- Prevented multi-turn session budget double-counting when projected messages are shallow-cloned by `context_edit`, `blockImages`, or `context` hooks.
- Respected `context_edit` omissions (`replacement: null`) and non-omitted error assistant boundaries when resolving authoritative user prompts on `sessionManager.getBranch()`.
- Guarded async classifier routing against mid-flight Escape/abort signals so cancelled turns do not auto-pin first-turn heuristic fallback decisions or mutate router state, rejected non-`router` virtual targets (`api === 'pi-virtual'`) in fallback chains, and preserved colons in chat-LLM classifier `Reasoning:` lines.

## [0.5.7] - 2026-11-27

### Added

- Rate-limit cooldown tracking via Pi `1.6.1`'s `after_provider_response` hook (reading HTTP `429` / `503` / `529` status and `Retry-After` / `retry-after-ms` headers across providers) to automatically route around cooling-down models and surface active cooldowns in `/router status` and the status widget.
- Interactive `ctx.ui.select()` pickers (with Pi `1.6.1`'s `blockedKind: 'question'` program status) when running `/router profile` or `/router pin` without arguments in UI-capable sessions.
- Support and documentation for Pi `1.6.1`'s new native decision models (`github-copilot/gpt-6-luna-decisions` with image input and Radius `pi-decision` models with `sessionId` correlation), plus `disableContinuation: true` on chat-LLM classifier calls to avoid mutating Anthropic message threads.

### Changed

- Preserved the active primary model on post-compaction context-overflow and truncated-length recovery retries (`isContextOverflow` / `stopReason === 'length'`) when the compacted conversation fits, rotating to larger-context fallbacks only when the request still exceeds the model's context window.
- Resolved projected user prompts and attached images across `ctx.sessionManager.getBranch()` (preserving `context_edit` / `context` redactions while skipping trailing `custom_message` / `!bash` injections and synthetic compaction/branch summary wrappers) so extension-injected context does not skew heuristic or classifier routing.
- Dynamically resolved virtual model `input` modalities (`['text']` vs `['text', 'image']`) from configured tier and fallback models, and added downward vision-tier fallback when higher tiers are text-only.
- Updated peer-tested Pi packages to `1.6.1`, `oxfmt` to `^0.80.0`, and `vitest` to `^5.1.2`.

## [0.5.6] - 2026-11-22

### Changed

- Omitted `off` from registered virtual model `thinkingLevels` when all configured tiers in a profile explicitly disallow `off` (such as `openai/gpt-6.2-astra` and `openai/gpt-6.2-sol` added in Pi `1.6.0`).
- Deduplicated session state snapshotting, usage cost accounting, and unsupported thinking-level warning helpers across router modules.
- Updated example configurations in `model-router.example.json` and `README.md` to current Pi `1.6.0` catalog models and `/llama` default port details.
- Updated peer-tested Pi packages to `1.6.0`, `oxfmt` to `^0.79.0`, and `vitest` to `^5.1.1`.

### Fixed

- Re-tallied post-snapshot branch costs cleanly and cleared snapshot deduplication state during in-session `/tree` navigation (`restoreStateFromSession`).
- Hardened virtual router state comparison and persisted state snapshotting against partial or nullish `lastDecision` entries.

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
