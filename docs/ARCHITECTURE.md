# Architecture: Pi Model Router Extension

The `pi-model-router` is an extension-first model router for the `pi` coding agent. It registers a custom logical provider (`router`) that exposes "profiles" as models (e.g., `router/balanced`). For every turn, the router intelligently selects an underlying concrete model based on task complexity, conversation phase, and user-defined rules.

## Core Concepts

### 1. Profiles & Tiers

The router is organized into **Profiles** (e.g., `balanced`, `cheap`, `deep`). Each profile defines up to three **Tiers** (at least one required):

- **High**: Reserved for architecture, design, complex debugging, and planning. Uses high-reasoning models.
- **Medium**: The default for standard implementation, multi-file edits, and focused fixes.
- **Low**: Used for summaries, changelogs, formatting, and simple read-only lookups.

### 2. Virtual Model Implementation

The extension uses `pi.registerVirtualModel` (and `pi.unregisterVirtualModel`) to register each configured profile under the `router` provider (`router/<profile>`). Pi cleanly separates **Selection** (`model_change` entries keep `router/<profile>`) from **Dispatch** (each assistant message records the physical `provider`, `model`, and `thinkingLevel`). This provides:

- Native footer display (`profile • level → physical-model • level`) and per-physical-model cost breakdown in `/session`.
- Safe conversation replay across different physical models and providers.
- Native pre-request auto-compaction when routing to a physical model whose context window is smaller than the current transcript.

## Routing Decision Flow

For every request sent to a `router/*` virtual model, `route(request, ctx)` inspects `request.reason`:

- **`direct` requests** (e.g., compaction summaries): Routed directly to the `medium` (or pinned) tier without mutating session routing state or running the classifier.
- **`continuation` requests** (tool-result continuations within a turn): Preserves the previous routed model for the turn to maintain provider prompt caches and thinking signatures (unless a new pin, budget cap, or image attachment requires switching).
- **`retry` requests** (automatic retry after a failed request): Advances to the next available model in the tier's `fallbacks` chain after `request.failed.model`.
- **`user` requests** (new user prompt, steer, or follow-up): Executes the full tier selection pipeline:
  1. **Budget Check**: If `maxSessionBudget` is configured and session spend exceeds it, downgrades `high` tier requests to `medium`.
  2. **Manual Pin**: Uses the tier pinned via `/router pin` or `/router fix`.
  3. **Custom Rules**: Matches keyword-based rules defined in config against the user prompt.
  4. **Classifier (Optional)**: When `classifierModel` is configured, prefers Pi's native classifier models (`ctx.modelRegistry.classify()` with `"auto"`, TypeSafe Jev, Cloudflare Clef / Clef Omni, OpenAI GPT-6 Luna, or `llama.cpp` classifiers — with image filtering and text-only fallback) and falls back to chat LLM classification (`ctx.modelRegistry.streamSimple()`).
  5. **Heuristics (Fallback)**: Uses fast local heuristics (keyword/length/tool-use analysis) if the classifier is off or fails.
  6. **Biased Stickiness**: The `phaseBias` setting modulates heuristic thresholds and low-confidence classifier probabilities to keep the router in a consistent phase.

## Module Architecture

The extension is modularized for maintainability:

- `extensions/index.ts`: Orchestrator. Manages state, hooks into `pi` events, and wires modules together.
- `extensions/provider.ts`: Implements the `router` provider and the delegation/retry loop.
- `extensions/routing.ts`: Core decision logic, heuristics, and the LLM classifier.
- `extensions/config.ts`: Loads, merges, and normalizes the JSON configuration.
- `extensions/commands.ts`: Registers all `/router` subcommands and their autocompletions.
- `extensions/ui.ts`: Manages the status line and the optional state widget.
- `extensions/state.ts`: Handles session-persisted state and snapshots.
- `extensions/types.ts`: Centralized interface and type definitions.

## State & Persistence

The router state is persisted using `pi.appendEntry` with a custom type `router-state`. This allows the router to:

- Restore the active profile and pins across agent relaunches.
- Maintain independent pins and state for different conversation branches.
- Track accumulated session costs safely.

## Reliability: Fallback Chains

Each tier in a profile can define an optional `fallbacks` list. If the primary model fails (e.g., due to rate limits or provider downtime), the router automatically retries the next model in the chain before surfacing an error to the user.
