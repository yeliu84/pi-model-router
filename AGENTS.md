# Pi Model Router: Core Mandates

## Project Overview

The `pi-model-router` is an extension-first model router for the `pi` coding agent. It registers a custom logical provider (`router`) that exposes "profiles" as models (e.g., `router/auto`). For every turn, the router intelligently selects an underlying concrete model based on task complexity, conversation phase, and user-defined rules.

## Architectural Principles

- **Extension-First**: All functionality must be implemented as a `pi` extension without modifying `pi` core.
- **Virtual Models**: Use `pi.registerVirtualModel` (and `pi.unregisterVirtualModel`) to expose profiles (`router/<profile>`) as virtual models. Selection remains stable on the virtual model while each request routes to a concrete physical model and thinking level.
- **Modularized Design**: Strictly follow the modular structure defined in Phase 3:
  - `extensions/types.ts`: All interfaces and type definitions.
  - `extensions/config.ts`: Configuration loading, normalization, and merging.
  - `extensions/routing.ts`: Core routing logic (heuristics, native & LLM classifiers, rule matching).
  - `extensions/provider.ts`: Virtual model registration (`router/*`) and `route(request, ctx)` handler.
  - `extensions/state.ts`: Session-persisted state management and snapshotting.
  - `extensions/ui.ts`: UI status line and widget rendering logic.
  - `extensions/commands.ts`: CLI command registrations and completions.
  - `extensions/index.ts`: Main entry point (orchestrator).

## Routing Decision Logic

Routing follows a tiered system (`high`, `medium`, `low`) and an ordered decision flow:

1. **Budget Check**: Downgrade to `medium` if `maxSessionBudget` is exceeded.
2. **Manual Pin**: Use tier pinned via `/router pin` or `/router fix`.
3. **Custom Rules**: Check keyword-based rules against the user prompt.
4. **LLM Classifier (Optional)**: Call `classifierModel` for intent categorization.
5. **Heuristics (Fallback)**: Use local heuristics if the classifier is off/fails.
6. **Phase Bias**: Apply stickiness to maintain a consistent tier during multi-turn tasks.

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
