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

For every request sent to a `router/*` model, the following logic is executed in order:

### Decision Phase (inside `decideRouting()`)

1. **Manual Pin**: If the user has pinned a tier via `/router pin` or `/router fix`, that tier is used immediately. No further routing logic runs.
2. **Custom Rules**: Keyword-based rules defined in the config are checked against the user prompt. If any match, the configured tier is used.
3. **Heuristics + Phase Bias**: A fast local analysis considers word count, keywords, explicit hints, tool results, multi-line prompts, conversation history, and the previous phase. The `phaseBias` setting modulates thresholds to keep the router in a consistent phase (e.g., staying in `high` tier during a multi-turn planning session; making it harder to drop to `low` during implementation).
4. **Budget Check**: If a `maxSessionBudget` is configured and the accumulated session spend exceeds it, any `high` tier decision is automatically downgraded to `medium`.

### Post-Heuristic Overrides (in `provider.ts`)

5. **Context Trigger** (optional): If `largeContextThreshold` is exceeded (measured in tokens via `ctx.getContextUsage()`), the router **upgrades** to the `high` tier regardless of the heuristic decision. This only upgrades — it never downgrades.
6. **LLM Classifier** (optional): If `classifierModel` is configured **and** no pin is set, no rule matched, and no context trigger fired, a fast LLM is called to categorize the user's intent. Its decision overrides the heuristic result. If the classifier chooses `high` but the budget is exceeded, it is re-downgraded to `medium`.

### Post-Route Corrections

7. **Google Thinking Tool Continuation**: If the last message is a tool result and the previous turn used a Google model with thinking enabled, the exact same model/tier is preserved to avoid thought-signature replay errors — even if the heuristic would route differently.
8. **Image-Aware Escalation**: If the user attached an image and the routed tier's model doesn't support image inputs, the router escalates to the next higher tier (`low → medium → high`) that supports images.

### Execution Phase

9. **Auto-Context Truncation**: Before delegation, if the target model's context window is smaller than what the router reported (always the `high` tier model's capacity), the conversation is truncated by removing oldest messages while preserving the system prompt and the most recent message.
10. **Fallback Chain**: If the primary model fails (rate limit, downtime, auth error), the router retries each configured fallback in sequence. If all fail, the error is surfaced to the user.

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
