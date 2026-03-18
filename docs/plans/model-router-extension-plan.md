# Pi Model Router Extension Plan

Status: In progress
Project: `/Users/ye/Workspace/pi-model-router`
Last updated: 2026-03-18

## Progress

- [x] Create project workspace at `~/Workspace/pi-model-router`
- [x] Save approved implementation plan under `docs/plans`
- [x] Validate extension-first architecture with a custom `router` provider spike
- [x] Implement config loading for router profiles
- [x] Register logical router models such as `router/auto`
- [x] Implement heuristic per-turn routing (`high` / `medium` / `low`)
- [x] Delegate routed requests to underlying provider models via `pi-ai`
- [x] Persist router state in session entries
- [x] Add router commands (`/router`, `/router-profile`, `/router-reload`, `/router-debug`)
- [x] Add status UI showing effective routed tier/model
- [x] Add package metadata and installation docs
- [x] Harden config/state handling and add explicit `/router-on` / `/router-off` commands
- [x] Add `/router-pin high|medium|low|auto` to override heuristic tier selection
- [x] Make router pinning persist per profile and improve `/router-debug` with recent decision history
- [x] Allow pinning other profiles without switching and add a router state widget

## Objective

Build a configurable model router for pi as an extension/package, without modifying pi core. The router should expose a stable logical model such as `router/auto`, then choose the actual model behind the scenes per turn based on task difficulty and conversation phase.

## Why extension-first

Pi already exposes the required extension primitives:

- custom providers via `pi.registerProvider(...)`
- model selection via `/model`
- thinking control via `pi.setThinkingLevel(...)`
- status/UI hooks via `ctx.ui.setStatus(...)`
- session persistence via `pi.appendEntry(...)`
- commands, shortcuts, and flags via the extension API

A provider-based extension is preferred over repeatedly calling `pi.setModel()` during routing, because `setModel()` behaves like a user-visible model switch and would create noisy session/default-model changes. A custom logical provider keeps the selected model stable while the extension routes internally.

## Package shape

Recommended package name:

- `pi-model-router`

Main components:

1. Extension entrypoint
   - registers custom provider `router`
   - registers commands for status/config/debugging
   - manages session-persisted router state
2. Config file
   - global: `~/.pi/agent/model-router.json`
   - project override: `.pi/model-router.json`
3. Optional docs/examples
   - install and setup instructions
   - sample profiles

## Core architecture

### 1. Custom provider

Register a custom provider named `router` with logical models such as:

- `router/auto`
- optionally `router/<profile-name>`

The provider uses a custom `streamSimple` implementation.

Request flow:

1. pi sends a request to `router/auto`
2. extension inspects request/history/router state
3. extension decides a tier: `high`, `medium`, or `low`
4. extension resolves that tier to a real configured model
5. extension delegates the actual request to that underlying model through `@mariozechner/pi-ai`
6. extension returns the streamed result to pi

This preserves a stable logical model for the user while still enabling internal per-turn routing.

### 2. Configurable profiles

Use explicit user-owned profile config.

Example:

```json
{
  "defaultProfile": "auto",
  "profiles": {
    "auto": {
      "high": {
        "model": "openai/gpt-5.4-pro",
        "thinking": "high"
      },
      "medium": {
        "model": "google/gemini-flash-latest",
        "thinking": "medium"
      },
      "low": {
        "model": "openai/gpt-5.4-nano",
        "thinking": "low"
      }
    }
  }
}
```

Tier values use object form so later versions can add:

- fallback chains
- classifier overrides
- tier-specific rules
- retry controls
- tool restrictions

### 3. Per-turn routing

Routing should happen per request/turn, not once per session.

Target behavior:

- planning/research turn -> `high`
- implementation turn -> `medium`
- trivial follow-up/summary turn -> `low`

## Routing policy

### v1 decision order

1. Hard rules first
2. Phase memory second
3. Optional classifier third

### Hard-rule routing

#### High

Use for:

- architecture
- design
- planning
- tradeoff analysis
- broad debugging / root cause analysis
- large refactors
- codebase research before action

#### Medium

Use for:

- implementation of a known plan
- multi-file edits
- normal coding work
- focused debugging
- tests/fixes/refactors with clear direction

#### Low

Use for:

- summaries
- changelogs
- formatting
- quick explanations
- small bounded transforms
- simple read-only lookup

### Phase memory

Maintain lightweight router state such as:

- `planning`
- `implementation`
- `lightweight`

Examples:

- if the session is clearly in planning, bias toward `high`
- after a plan is established and edits/tests begin, bias toward `medium`
- when the user asks for a short summary afterward, bias toward `low`

### Optional classifier

For ambiguous cases only.

Classifier output should include:

- chosen tier
- short reasoning
- confidence

Classifier should be optional in v1. The first implementation should work with heuristics only.

## State model

Persist only router state, not every internal model hop.

Persist:

- selected router profile
- router enabled/disabled state
- last known phase
- optional last effective tier/model for debugging

Do not persist invisible internal routed switches as normal user model changes.

Use `pi.appendEntry(...)` custom entries to restore state on resume and preserve branch-safe behavior.

## User experience

### Model selection

Primary UX:

- `/model router/auto`
- `/model router/<profile-name>`

### Commands

Recommended commands:

- `/router` — show current profile, phase, tier, effective model
- `/router-profile <name>` — switch profile
- `/router-on`
- `/router-off`
- `/router-debug`
- `/router-reload`
- `/router-pin high|medium|low|auto`
- `/router-pin <profile> <high|medium|low|auto>`

### UI/status

Pi’s footer will show the logical model (`router/auto`). The extension should additionally expose the effective routed model.

Example status text:

- `router:auto -> high -> openai/gpt-5.4-pro`
- `router:auto -> medium -> google/gemini-flash-latest`

Best v1 mechanism:

- `ctx.ui.setStatus("router", ...)`

Implemented in current preview:

- widget showing profile, phase, tier, and effective model

## Signals to inspect for routing

The router should inspect:

1. latest user message
2. recent conversation history
3. recent tool usage patterns
4. request breadth/complexity
5. optional explicit user hints such as fast/cheap/best

## Initial config scope

### v1 config

```json
{
  "defaultProfile": "auto",
  "debug": false,
  "profiles": {
    "auto": {
      "high": { "model": "openai/gpt-5.4-pro", "thinking": "high" },
      "medium": { "model": "google/gemini-flash-latest", "thinking": "medium" },
      "low": { "model": "openai/gpt-5.4-nano", "thinking": "low" }
    }
  }
}
```

### v2-ready reserved fields

Reserve room for:

- `classifierModel`
- `fallbacks`
- `rules`
- `phaseBias`
- `pinTier`
- `debugHistory`

## References in pi examples

Use existing pi examples as implementation references:

- `examples/extensions/preset.ts`
  - named profiles, commands, persistence, status
- `examples/extensions/plan-mode/`
  - phase-based workflow patterns
- custom provider examples
  - provider registration and delegated streaming

## Extension-only limitations

1. Built-in footer will show the logical router model, not the effective delegated model
   - workaround: custom status/widget
2. Routing quality depends on observable context and heuristics
3. Auth/availability delegation across underlying providers must be handled carefully
4. `router/auto` only works when the package is installed and loaded

## Delivery phases

### Phase 0: validation spike

Validate:

1. custom provider can register logical model `router/auto`
2. provider can delegate to an underlying real model through `pi-ai`
3. extension UI can show effective routed model/tier cleanly

### Phase 1: minimal usable router

Build:

- provider `router`
- profile `auto`
- config loading
- heuristic routing only
- status line showing effective model
- commands: `/router`, `/router-reload`

### Phase 2: better routing

Add:

- phase memory improvements
- optional classifier
- debug history

### Phase 3: package polish

Add:

- package metadata
- README
- install docs
- example configs
- optional example profiles such as `cheap` and `deep`

## Recommended v1 scope

Build exactly this first:

- package-based extension
- registers `router` provider
- user selects `router/auto`
- config has `high` / `medium` / `low`
- routing is heuristics-only
- status shows effective model
- commands:
  - `/router`
  - `/router-profile`
  - `/router-reload`
  - `/router-debug`

No classifier in v1.
No pi core changes.
No attempt to perfectly replicate vendor-specific internals.

## Progress notes

### 2026-03-18

- Approved extension-first architecture.
- Created project directory `~/Workspace/pi-model-router`.
- Saved initial plan to `docs/plans/model-router-extension-plan.md`.
- Scaffolded package files: `package.json`, `README.md`, `model-router.example.json`.
- Implemented a validation-spike extension at `extensions/index.ts`.
- Spike currently includes:
  - custom logical provider `router`
  - logical profile models derived from config (for example `router/auto`)
  - config loading from `~/.pi/agent/model-router.json` and `.pi/model-router.json`
  - heuristic `high` / `medium` / `low` routing
  - delegation to underlying provider models via `streamSimple(...)`
  - commands: `/router`, `/router-profile`, `/router-reload`, `/router-debug`
  - footer status text showing the last effective routed model
- Added project-local runtime test config at `.pi/model-router.json` using available local provider models.
- Runtime validation completed:
  - `pi -e ./extensions/index.ts --list-models router` shows `router/auto`
  - `pi -e ./extensions/index.ts --model router/auto -p "Summarize ..."` successfully delegated a low-tier request
  - `pi -e ./extensions/index.ts --model router/auto --mode json "Design an implementation plan ..."` showed delegation to `openai/gpt-5` for a high-tier planning request
- Implemented router state persistence in session entries:
  - writes `router-state` custom entries on `turn_end`
  - restores the last routing decision from session branch state on `session_start`
- Cleaned up rough edges in the validation spike:
  - added config parsing/validation with fallback behavior for invalid profile or tier definitions
  - added explicit `/router-on` and `/router-off` commands
  - track and restore selected profile, last non-router model, and last routing decision across session start/switch/fork
  - improved `/router` status output and command completions for profile names
  - expanded heuristic routing with explicit high/low user hints and better phase bias handling
- Added tier pinning support:
  - `/router-pin high|medium|low` now overrides heuristic tier selection
  - `/router-pin auto` clears the pin and restores heuristic routing
  - pin state is persisted in `router-state` and reflected in status output
- Extended pinning and debug behavior:
  - pins now persist per profile instead of as a single global session-wide override
  - `/router-pin <profile> <tier>` can now pin another profile without switching to it first
  - `/router-debug` can now show recent routing decisions and supports `on`, `off`, `toggle`, and `clear`
  - recent decision history is persisted in router state for easier inspection after resume
  - added a router widget showing the current profile, pin, and most recent effective route
- Re-validated the extension after the pinning/debug/widget update:
  - `pi -e ./extensions/index.ts --model router/auto --mode json "/router-pin high" "Summarize ..."` routes the summary turn through the pinned profile tier
  - `pi -e ./extensions/index.ts --model router/auto --mode json "/router-pin high" "/router-pin auto" "Summarize ..."` returns the summary turn to the heuristic path
- Next step: explore optional classifier support and any additional routing controls now that manual override and debugging are in place.
