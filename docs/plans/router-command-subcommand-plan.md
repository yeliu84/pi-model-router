# Router Command Subcommand Plan

Status: Completed
Last updated: 2026-03-20

## Objective
Consolidate the model router’s command surface around a single `/router` entrypoint that exposes subcommands, folding functionality from `/router-on`, `/router-off`, `/router-fix`, `/router-widget`, `/router-debug`, `/router-reload`, and others into logical subcommands and removing unnecessary standalone commands.

## Motivation
- Slash command proliferation increases cognitive load; keeping only `/router` keeps the UI simple while still surfacing all necessary controls via subcommands.
- Subcommands allow clearer grouping (e.g., `/router profile`, `/router pin`, `/router widget`, `/router debug`) and align with the user’s stated preference.
- Folding logic into one registered command avoids redundant command registration and makes help/status output easier to extend.

## Scope
- [x] Replace distinct `/router-on`, `/router-off`, `/router-fix`, `/router-widget`, `/router-debug`, and `/router-reload` commands with subcommands handled by `/router`.
- [x] Keep `/router-profile`, `/router-pin`, and `/router-thinking` semantics, but execute them via `/router profile …`, `/router pin …`, `/router thinking …` flows (with aliases if needed for compatibility).
- [x] Provide `/router status` for the current status output, meaning `/router` without subcommands defaults to status.
- [x] Ensure the new entry exposes the same completions/feedback as before and updates persistence/toolbar integration.
- [x] Update documentation/comments to describe the new command layout and available subcommands.

## Proposed subcommand design
1. `router` (no args) or `router status` → show status (current profile, pinned tier, cost, last decision, widget state). [DONE]
2. `router profile [name]` → show available profiles if no name; otherwise switch to named profile (enabling router implicitly). [DONE]
3. `router pin [profile] <tier|auto>` → set or clear pin for target profile. [DONE]
4. `router thinking ...` → same thinking overrides with rewritten handler but invoked via subcommand. [DONE]
5. `router disable` → disable router (formerly `/router-off`), restoring last non-router model. [DONE]
6. `router fix <tier>` → pin last decision tier (formerly `/router-fix`) as `pin` convenience, potentially as alias to `router pin <lastProfile> tier`. [DONE]
7. `router widget <on|off|toggle>` → toggle widget visibility. [DONE]
8. `router debug <on|off|toggle|clear|show>` → debug control moved under subcommand; this can also log to UI. [DONE]
9. `router reload` → reload config while keeping debug preserved (formerly `/router-reload`). [DONE]

## Implementation steps
1. [x] Sketch the new command parser: register only `/router` and switch on first argument (subcommand). Support `help`/`?` fallback to status.
2. [x] Move existing standalone logic into subcommand-specific helper functions, reusing completions where practical.
3. [x] Update `actions` props/persistance calls if the new handler needs to refer to `ctx` differently; ensure old command names either removed or kept as aliases for compatibility (optional).
4. [x] Remove unused command registrations after migration, ensuring the remaining code path uses the new command structure exclusively.
5. [x] Keep `/router` alias for status and ensure UI updates (notifications, status line) work identically.
6. [x] Add tests or manual verification steps: call `/router profile …`, `/router pin …`, `/router debug show`, `/router widget toggle`, `/router disable`, `/router reload`, `/router fix high`, `/router thinking …` and confirm behavior matches previous implementation.
7. [x] Update README and docs to explain the new subcommand usage (once plan approved).

## Risks & Mitigations
- **Loss of backward compatibility:** Provide short-lived compatibility by handling old command names as redirects to `/router` subcommands if absolutely necessary, or document the change clearly.
- **Command argument parsing regressions:** Rigorously reuse existing completion logic to avoid regression, adding unit-like tests for parser behavior if feasible.
- **Inconsistent UI updates:** Ensure each subcommand calls `actions.updateStatus` and persists state similar to previous handlers.

## Next steps (post-approval)
1. Implement `/router` subcommand parsing as described.
2. Remove legacy command registrations and ensure old command names redirect or are no-ops.
3. Update docs/README with the consolidated command list.
4. Run manual command tests and smoke-check router status widget updates.
