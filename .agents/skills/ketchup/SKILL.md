---
name: ketchup
description: Catch up pi-model-router with a new Pi release. Updates all dependencies, diffs Pi's changelog, type definitions, model catalog, and runtime internals since the last sync, fixes breaking changes, adopts high-value Pi capabilities, performs a deep bug-hunt and DRY audit, and optionally cuts and pushes a release. Use whenever Pi releases a new version or the user asks to catch up / sync dependencies with Pi.
---

# Ketchup: Pi Release Catch-Up Workflow

Catch up `pi-model-router` with the latest `pi` release end to end. Follow `AGENTS.md` mandates throughout.

Optional user instructions/arguments (e.g. `release`, `no-release`, or a specific focus): `$@`

> **Commit/Release Gate**: Complete Phases 1–4 first. Only execute Phase 5 (commit, version bump, annotated tag, and push) if the user explicitly requested it (for example via `/skill:ketchup release` or an explicit follow-up instruction).

---

## Phase 1: Baseline & Dependency Audit

1. Inspect repository state and identify the last Pi version synced:
   - `git status`
   - `git log -n 10 --oneline`
   - Read the top of `CHANGELOG.md` and `package.json`.
2. Check current vs. latest versions for peer and dev dependencies:
   ```bash
   npm ls --depth=0
   npm outdated || true
   for pkg in @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-agent-core @earendil-works/pi-tui oxfmt typescript vitest; do
     printf "%-36s %s\n" "$pkg" "$(npm view "$pkg" version)"
   done
   ```
3. Run the baseline check suite before making edits:
   ```bash
   npm run tsc && npm test && npm run fmt:check
   ```
4. **Before running `npm update`**, locate the newer installed Pi directory (if already updated globally) so you can diff old (`./node_modules/@earendil-works/*`) against new Pi directly:
   ```bash
   PI_NEW="$(node -e 'console.log(require.resolve("@earendil-works/pi-coding-agent/package.json", { paths: [process.env.HOME + "/.local/share/pi-coding-agent/lib/node_modules"] }))' 2>/dev/null | xargs dirname)"
   ```
   - If the global Pi install is not yet on the target version (or unavailable), inspect the old `node_modules/@earendil-works/*` version first, or snapshot its `.d.ts` files to `/tmp/pi-old-dts` before updating so Phase 2 diffs remain exact.

---

## Phase 2: Deep Analysis of Pi Changes Since Last Sync

Inspect everything Pi changed between the previously synced Pi version and the new Pi version:

1. **Read Pi's `CHANGELOG.md`** from the new version down to the last synced version (`$PI_NEW/CHANGELOG.md`).
2. **Diff TypeScript declarations (`.d.ts`)** across all four `@earendil-works/pi-*` packages (`pi-agent-core`, `pi-ai`, `pi-tui`, `pi-coding-agent`):
   ```bash
   diff -ru -x '*.js' -x '*.map' -x '*.json' -x '*.wasm' -x '*.html' -x '*.css' \
     "./node_modules/@earendil-works/pi-coding-agent/dist" "$PI_NEW/dist" || true
   ```
   Repeat for `pi-ai`, `pi-agent-core`, and `pi-tui`.
3. **Inspect Pi internals and docs relevant to `pi-model-router`**:
   - **Virtual models & session lifecycle**: `dist/core/virtual-models.*`, `dist/core/model-runtime.*`, `dist/core/agent-session.js`, `docs/virtual-models.md`, `examples/extensions/jev-router.ts`.
   - **Extension events & UI APIs**: `dist/core/extensions/types.d.ts` (new events, event payload changes, `ctx.ui.*` options, `ExtensionContext`, `ModelRegistry`).
   - **Decision / classifier models**: `pi-ai/dist/api/*` (especially `pi-decision`, `openai-decisions`, `system-one-shared`, `typesafe-system-one`, `cloudflare-workers-ai-system-one`, `llama-cpp-classify`), `docs/models.md`, `docs/codemode.md`, `docs/llama-cpp.md`.
   - **Model catalog & thinking level maps**: diff `pi-ai/dist/providers/data/*.json` for:
     - New/removed classifier models (`type === "classifier"`) and their `api`, `input`, and `compat.imageInput`.
     - `thinkingLevelMap` changes (especially `off: null`, `xhigh`, `max`).
     - Retired or renamed models referenced in `model-router.example.json` or `README.md`.
   - **Retry, overflow, cache warming & cost accounting**: `pi-ai/dist/utils/provider-retry.js`, `pi-ai/dist/utils/overflow.d.ts`, `pi-ai/dist/utils/openrouter-cost.js`, `dist/core/usage-totals.js`, `dist/core/cache-warmer.js`.
4. **Triage findings into four buckets**:
   - **Breaking changes** requiring immediate fixes.
   - **High-value capabilities** that materially improve routing accuracy, resilience, cost accounting, or UX (skip noisy or low-value churn).
   - **Catalog / docs / schema / example updates** (verify every model ID in `model-router.example.json` exists in Pi's updated catalog).
   - **Not applicable** (note briefly why skipped).

---

## Phase 3: Update Dependencies & Implement Adjustments

1. Update `devDependencies` in `package.json` to current versions and run:
   ```bash
   npm update && npm ls --depth=0 && (npm outdated || true)
   ```
   Verify `0 vulnerabilities` and confirm peer packages resolved to the target Pi version in `package-lock.json`.
2. Implement breaking-change adjustments and selected high-value Pi capabilities while strictly adhering to `AGENTS.md`:
   - Keep the modular layout: `extensions/{types,constants,config,routing,provider,state,ui,commands,index}.ts`.
   - Strict TypeScript: **NEVER** use `any` (use specific types or `unknown`).
   - Functions: **ALWAYS** use arrow functions (`const fn = () => ...`), never `function` statements.
   - Imports: top-level static ESM imports only (no inline `import()` or `require()`).
   - State: persist via `pi.appendEntry('router-state', ...)` for branch-safe history.
3. Add or update unit and integration tests across `extensions/*.test.ts` covering all new behavior and edge cases.
4. Keep documentation and schemas in sync:
   - `README.md`
   - `docs/ARCHITECTURE.md`
   - `model-router.example.json` (verify every referenced model ID exists in Pi's catalog)
   - `model-router.schema.json`
   - `CHANGELOG.md` (add entries under `## [Unreleased]`)
5. Run verification:
   ```bash
   npm run fmt && npm run fmt:check && npm run tsc && npm test
   ```

---

## Phase 4: Deep Bug-Hunt, Optimization & DRY Audit

Before finishing, audit the complete `git diff -- ':!package-lock.json'` with a critical eye and cross-check every assumption against Pi's actual runtime JS in `node_modules/@earendil-works/*`:

1. **Bug-hunt checklist**:
   - **Provider/transport asymmetry**: Check every provider adapter in `pi-ai/dist/api/` for callback differences (e.g., HTTP error vs. `200 OK` hooks, WebSocket vs. HTTP, empty headers, missing usage).
   - **Session projection & branch semantics**: Verify interactions with `context_edit`, `pi.on('context')` redactions, `blockImages`, `custom_message`, `bashExecution`, `compaction`, `branch_summary`, `/tree` navigation, and `session_compact_failed`.
   - **Mid-turn cache & thinking stickiness**: Ensure `continuation` requests do not unnecessarily switch physical models or drop prompt caches / thinking signatures; verify `direct` requests never mutate session routing state.
   - **State & flag invariants**: Check `isFallback`, `inFlightModelRef`, `countedObjects` (`WeakSet`), snapshot deduplication, header/date parsing (`Number(...)` vs `parseFloat(...)` traps), and timeout/cooldown bounds.
   - **Failure & cancellation paths**: Verify Escape/abort cancellation, stale `ExtensionContext` safety, and missing credentials fallback behavior.
2. **DRY & performance pass**:
   - Consolidate duplicated loops, candidate-reordering logic, dialog pickers, and formatting branches into small, single-purpose helpers.
   - Avoid unnecessary full-transcript allocations in hot routing paths (`O(limit)` reverse scans, in-place character counting).
3. Add regression tests for every bug fixed during the audit.
4. Run the full verification gate:
   ```bash
   npm run fmt && npm run fmt:check && npm run tsc && npm test
   grep -rn -E "\bany\b|\bfunction\s+[a-zA-Z_]|require\(" extensions/*.ts || true
   ```
   (Confirm any `any` hits are only Vitest `expect.any(...)` or comments/strings.)

---

## Phase 5: Commit, Bump Version, Tag & Push (Only When Requested)

Follow the repository's two-commit release convention:

1. **Feature commit** (keep `## [Unreleased]` in `CHANGELOG.md`):
   ```bash
   git add -A
   git commit -m "feat: update to Pi <X.Y.Z>, <concise summary of key changes>"
   ```
2. **Bump version** (default `patch`, or `minor` if requested):
   ```bash
   npm version patch --no-git-tag-version
   ```
3. **Stamp `CHANGELOG.md`**: replace `## [Unreleased]` with `## [<new-version>] - $(date +%Y-%m-%d)`.
4. **Re-verify**:
   ```bash
   npm run fmt:check && npm run tsc && npm test
   ```
5. **Release commit, annotated tag, and push**:
   ```bash
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "Release <new-version>"
   git tag -a "v<new-version>" -m "Release <new-version>"
   git push origin main "v<new-version>"
   ```
6. Verify clean state with `git status`, `git log -n 3 --oneline --decorate`, and `git tag -n9 -l "v<new-version>"`.
