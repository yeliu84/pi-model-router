# Architecture: Pi Model Router Extension

The `pi-model-router` registers a custom logical provider (`router`) that exposes "profiles" as models (e.g., `router/auto`). For every turn, the router selects an underlying concrete model based on task complexity, conversation phase, and user-defined rules.

> For the full decision-pipeline reference (heuristic details, budget/context controls, fallback chains, image-aware escalation, Google thinking tool continuation, auto-context truncation, and thinking control), see [How Routing Works](../README.md#how-routing-works) in the README.

## Module Architecture

The extension is modularized for maintainability:

- **`extensions/index.ts`**: Orchestrator. Manages state, hooks into `pi` events, and wires modules together.
- **`extensions/provider.ts`**: Implements the `router` provider and the delegation/retry loop.
- **`extensions/routing.ts`**: Core decision logic, heuristics, and the LLM classifier.
- **`extensions/config.ts`**: Loads, merges, and normalizes the JSON configuration.
- **`extensions/commands.ts`**: Registers all `/router` subcommands and their autocompletions.
- **`extensions/ui.ts`**: Manages the status line and the optional state widget.
- **`extensions/state.ts`**: Handles session-persisted state and snapshots.
- **`extensions/types.ts`**: Centralized interface and type definitions.

### Data Flow

```
po or turn_end event
      │
      ▼
index.ts ──→ routing.ts (decideRouting)
      │               │
      │               ▼
      │          config.ts (load profiles, rules, thresholds)
      │               │
      │               ▼
      │          state.ts (read pins, thinking overrides, debug history)
      │               │
      │               ▼
      │          Return RoutingDecision
      │
      ▼
provider.ts (streamSimple)
      │
      ├─→ Google lock: preserve exact model if Google thinking continuation
      ├─→ Classifier gating:
      │     ├─ New user message? → run full pipeline
      │     ├─ Tool continuation # ≤ initialContinuations? → run
      │     ├─ Consecutive failures ≥ failureTrigger? → run (crisis)
      │     ├─ Continuation % cadence === 0? → run (periodic)
      │     └─ Otherwise → reuse previous decision
      ├─→ Post-route corrections (context trigger, image escalation)
      ├─→ Auto-context truncation
      ├─→ Delegate to target model
      └─→ Fallback chain on failure
      │
      ▼
ui.ts (update status line + widget)
state.ts (persist decision, cost, history)
```

## State & Persistence

Router state is persisted using `pi.appendEntry` with a custom type `router-state`. This allows the router to:

- Restore the active profile and pins across agent relaunches.
- Maintain independent pins and state for different conversation branches via `sessionManager.getBranch()`.
- Track accumulated session costs safely across restarts.

### Persisted Fields

| Field | Type | Description |
|---|---|---|
| `selectedProfile` | `string` | Active profile name |
| `pinnedTierByProfile` | `Record<string, TierLevel>` | Manual tier pins per profile |
| `thinkingOverride` | `Record<string, Record<string, ThinkingLevel>>` | Runtime thinking overrides |
| `debugEnabled` | `boolean` | Debug mode state |
| `widgetEnabled` | `boolean` | Widget visibility |
| `lastDecision` | `RoutingDecision` | Most recent routing decision |
| `lastNonRouterModel` | `string` | Last model used before switching to router |
| `accumulatedCost` | `number` | Session cost accumulator (branch-safe) |
| `debugHistory` | `RoutingDecision[]` | Recent routing decisions |

> **Branch safety**: Because state is saved via `pi.appendEntry`, each conversation branch gets its own independent state. Switching branches restores the pins, cost, and history that were active on that branch.

### Debug History

The debug history stores the last 12 routing decisions (`MAX_DEBUG_HISTORY` in `constants.ts`). When debug mode is enabled (`/router debug on`), each decision is appended to `debugHistory` and shown in the status widget. The widget displays the most recent entries (truncated by pi's 10-line widget limit, newest first), and `/router debug show` prints the full history.