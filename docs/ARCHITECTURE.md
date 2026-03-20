# Architecture: Pi Model Router Extension

The `pi-model-router` is an extension-first model router for the `pi` coding agent. It registers a custom logical provider (`router`) that exposes "profiles" as models (e.g., `router/auto`). For every turn, the router intelligently selects an underlying concrete model based on task complexity, conversation phase, and user-defined rules.

## Core Concepts

### 1. Profiles & Tiers

The router is organized into **Profiles** (e.g., `auto`, `cheap`, `deep`). Each profile defines three **Tiers**:

- **High**: Reserved for architecture, design, complex debugging, and planning. Uses high-reasoning models.
- **Medium**: The default for standard implementation, multi-file edits, and focused fixes.
- **Low**: Used for summaries, changelogs, formatting, and simple read-only lookups.

### 2. Custom Provider Implementation

The extension uses `pi.registerProvider` to hook into the `pi` model lifecycle. This ensures that the selected model in the `pi` footer remains stable (e.g., `router/auto`) while the underlying model changes transparently turn-by-turn via the `streamSimple` interception.

## Routing Decision Flow

For every request sent to a `router/*` model, the following logic is executed:

1. **Budget Check**: If a `maxSessionBudget` is configured and the session spend exceeds it, the router automatically downgrades `high` tier requests to `medium`.
2. **Context Trigger**: If `largeContextThreshold` is exceeded (measured in tokens), the router forces the `high` tier to ensure the model can handle the large context.
3. **Manual Pin**: If the user has pinned a tier via `/router pin` or `/router fix`, that tier is used.
4. **Custom Rules**: Keyword-based rules defined in the config are checked against the user prompt.
5. **LLM Classifier (Optional)**: If `classifierModel` is configured, a fast LLM is called to categorize the user's intent.
6. **Heuristics (Fallback)**: If the classifier is off or fails, a fast local heuristic (keyword/length/tool-use analysis) is used.
7. **Biased Stickiness**: The `phaseBias` setting modulates thresholds to keep the router in a consistent phase (e.g., staying in `high` tier during a multi-turn planning session).

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

