# Pi Model Router: Core Mandates

## Project Overview
The `pi-model-router` is an extension-first model router for the `pi` coding agent. It registers a custom logical provider (`router`) that exposes "profiles" as models (e.g., `router/auto`). For every turn, the router intelligently selects an underlying concrete model based on task complexity, conversation phase, and user-defined rules.

## Architectural Principles
- **Extension-First**: All functionality must be implemented as a `pi` extension without modifying `pi` core.
- **Custom Provider**: Use `pi.registerProvider` to hook into the model lifecycle. The logical model (e.g., `router/auto`) should remain stable while the underlying model changes transparently.
- **Modularized Design**: Strictly follow the modular structure defined in Phase 3:
  - `extensions/types.ts`: All interfaces and type definitions.
  - `extensions/config.ts`: Configuration loading, normalization, and merging.
  - `extensions/routing.ts`: Core routing logic (heuristics, classifier, rule matching).
  - `extensions/provider.ts`: Custom `router` provider registration and delegation stream.
  - `extensions/state.ts`: Session-persisted state management and snapshotting.
  - `extensions/ui.ts`: UI status line and widget rendering logic.
  - `extensions/commands.ts`: CLI command registrations and completions.
  - `extensions/constants.ts`: Named constants (e.g. `MAX_DEBUG_HISTORY`).
  - `extensions/index.ts`: Main entry point (orchestrator).

## Routing Decision Logic
Routing follows a tiered system (`high`, `medium`, `low`) and an ordered decision flow:
### Decision Phase (inside `decideRouting()`)
1. **Manual Pin**: Use tier pinned via `/router pin` or `/router fix` if set.
2. **Custom Rules**: Check keyword-based rules against the user prompt.
3. **Heuristics + Phase Bias**: Local analysis (word count, keywords, tool usage, conversation length) with phase-behavior stickiness applied via threshold modulation.
4. **Budget Check**: Downgrade to `medium` if `maxSessionBudget` is exceeded.

### Post-Heuristic Overrides (in `provider.ts`)
1. **Context Trigger**: Upgrade to `high` if `largeContextThreshold` is reached.
2. **LLM Classifier (Optional)**: Call `classifierModel` for intent categorization (only if no pin, no rule match, and no context trigger fired). Budget is re-checked after classifier override.

### Post-Route Corrections
1. **Google Thinking Tool Continuation**: Preserve the exact model/tier when a Google tool-result continuation is detected, to avoid thought-signature replay errors.
2. **Image-Aware Escalation**: Escalate to a higher tier if the routed model doesn't support image attachments.

## Coding Standards
- **TypeScript**: Strictly adhere to TypeScript. NEVER use the `any` type; prefer specific types or `unknown`.
- **Functions**: Always use arrow functions (`const myFunc = () => ...`) instead of function statements (`function myFunc() ...`) for consistency and lexical scoping.
- **Imports**: Use top-level static imports over inline `import()` or `require()` calls for consistency and cleaner ESM code.
- **State Management**: Persist router state via `pi.appendEntry` with a custom `router-state` entry type to ensure branch-safe behavior.
- **Error Handling**: Implement robust fallback chains for model failures (retrying with alternative models).

## Documentation Reference
- `docs/ARCHITECTURE.md`: Detailed architectural deep dive.
- `README.md`: Usage and installation guide.
- `model-router.example.json`: Reference for configuration structure.
