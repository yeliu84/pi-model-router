# pi-model-router

Smart per-turn model router extension for the [pi-coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) that optimizes your AI budget and usage limits without sacrificing quality by dynamically routing each turn to the optimal LLM tier. It automatically selects between high, medium, and low-tier models based on task intent, session budget, context size, and custom rules — complete with automatic fallbacks and phase awareness.

## What it does

- **Logical Router Provider**: Registers a `router` provider that exposes stable profiles (e.g., `router/balanced`) as models.
- **Per-Turn Routing**: Intelligently chooses between `high`, `medium`, and `low` tiers for every turn based on task intent and complexity.
- **Task-Aware Heuristics**: Detects planning vs. implementation vs. lightweight tasks using keyword analysis, word count, and conversation history.
- **Advanced Controls**: Includes built-in support for:
  - **LLM Intent Classifier**: Optionally use a fast model to categorize intent (overrides heuristics).
  - **Custom Rules**: Define keyword-based tier overrides for specific patterns (e.g., `deploy` → `high`).
  - **Cost Budgeting**: Set a session spend limit; high tier downgrades to medium once exceeded.
  - **Fallback Chains**: Automatic retry with alternative models if the primary choice fails.
- **Phase Memory**: Biased stickiness to keep you in the same tier during multi-turn planning or implementation work.
- **Thinking Control**: Full control over reasoning/thinking levels per tier and profile. Changing pi's thinking level (e.g. via `shift+tab`) automatically applies as an all-tier override for the active router profile.
- **Persistent State**: Pins, costs, and debug history are remembered across agent restarts and conversation branches. When Pi starts on the router provider, new sessions use the last selected router profile if it is still configured. An explicit `--model` selection takes precedence.

## Installation

### As a user

Install from npm:

```bash
pi install npm:@yeliu84/pi-model-router
```

### For development

Clone this repo and install from source:

```bash
pi install .
```

Or load directly for one run:

```bash
pi -e ./extensions/index.ts
```

## Configuration

Copy the example config to one of:

- `~/.pi/agent/model-router.json` (Global)
- `.pi/model-router.json` (Project-specific)

The extension stores the last selected profile in `~/.pi/agent/model-router-state.json`. It restores this preference only when Pi starts on the router provider without an explicit `--model` selection. Branch-specific state remains in Pi session entries and takes precedence when a session is resumed.

### Basic Config Shape

```json
{
  "classifierModel": "google/gemini-flash-latest",
  "maxSessionBudget": 1.0,
  "profiles": {
    "auto": {
      "high": { "model": "openai/gpt-5.4-pro", "thinking": "high" },
      "medium": { "model": "google/gemini-flash-latest", "thinking": "medium" },
      "low": { "model": "openai/gpt-5.4-nano", "thinking": "low" }
    }
  }
}
```

### Configuration Fields

| Field                   | Description                                                                       |
| ----------------------- | --------------------------------------------------------------------------------- |
| `classifierModel`       | (Optional) Model used to categorize intent. Supports model aliases. If omitted, fast heuristics are used. |
| `maxSessionBudget`      | (Optional) USD budget for the session. Forces `medium` tier once exceeded.        |
| `phaseBias`             | (0.0 - 1.0) Stickiness of the current phase. Higher = more stable. Default `0.5`. |
| `rules`                 | List of custom keyword rules (e.g. `{ "matches": "deploy", "tier": "high" }`).    |
| `models`                | (Optional) Map of model aliases to definitions with `model`, `contextWindow`, `maxTokens`. |
| `profiles`              | Map of profile definitions, each containing optional `high`, `medium`, and `low` tiers (at least one required). Tier models can reference aliases from `models`. |

## Commands

| Command                     | Description                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| `/router`                   | Show detailed status, current profile, spend, and settings.                     |
| `/router status`            | Alias for `/router` (show current status).                                      |
| `/router profile [name]`    | Switch to a profile or list available ones (enables router if off).             |
| `/router pin <t\|a>`        | Pin a tier (high/medium/low/auto) for the active profile.                      |
| `/router fix <tier>`        | Correct the _last_ decision and pin that tier for the current profile.          |
| `/router thinking <level>`  | Override thinking level for all tiers (e.g. `/router thinking max`). Not all tier models may support every level. |
| `/router thinking <tier> <level>` | Override thinking level for a specific tier (e.g. `/router thinking low off`). |
| `/router disable`           | Disable the router and switch back to the last non-router model.                |
| `/router widget <on\|off>`  | Toggle the persistent state widget (supports `toggle`).                         |
| `/router debug <on\|off>`   | Toggle turn-by-turn routing notifications (supports `toggle`, `clear`, `show`). |
| `/router reload`            | Hot-reload the configuration JSON.                                              |
| `/router help`              | Show usage help for all subcommands.                                            |

## Documentation

- [Architecture Guide](docs/ARCHITECTURE.md): Deep dive into the routing logic and modular design.
- [Sample Configuration](model-router.example.json): Diverse profile examples (`cheap`, `deep`, `balanced`).
