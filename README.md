# pi-model-router

Modular, extension-first model router for the [pi](https://github.com/mariozechner/pi-coding-agent) coding agent.

## What it does

- **Logical Router Provider**: Registers a `router` provider that exposes stable profiles (e.g., `router/auto`) as models.
- **Per-Turn Routing**: Intelligently chooses between `high`, `medium`, and `low` tiers for every single turn based on task complexity.
- **Advanced Controls**: Includes built-in support for:
  - **LLM Intent Classifier**: Use a fast model to categorize your requests.
  - **Custom Rules**: Define keyword-based overrides for specific tasks.
  - **Context Trigger**: Automatically upgrade to high-reasoning models for large context tasks.
  - **Cost Budgeting**: Set a session spend limit; once reached, the router stays in lower-cost tiers.
  - **Fallback Chains**: Automatic retry with alternative models if the primary choice fails.
- **Phase Memory**: Biased stickiness to keep you in the same tier during multi-turn planning or implementation.
- **Thinking Control**: Full control over thinking/reasoning levels per tier.
- **Persistent State**: Pins, profiles, and costs are remembered across agent restarts and conversation branches.

## Installation

From this project directory:

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

### Basic Config Shape

```json
{
  "defaultProfile": "auto",
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
| `defaultProfile`        | The profile to use when starting a new session.                                   |
| `classifierModel`       | (Optional) Model used to categorize intent. If omitted, fast heuristics are used. |
| `maxSessionBudget`      | (Optional) USD budget for the session. Forces `medium` tier once exceeded.        |
| `largeContextThreshold` | (Optional) Token count trigger to force `high` tier for large contexts.           |
| `phaseBias`             | (0.0 - 1.0) Stickiness of the current phase. Higher = more stable. Default `0.5`. |
| `rules`                 | List of custom keyword rules (e.g. `{ "matches": "deploy", "tier": "high" }`).    |
| `profiles`              | Map of profile definitions, each containing `high`, `medium`, and `low` tiers.    |

## Commands

| Command                     | Description                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| `/router`                   | Show detailed status, current profile, spend, and settings.                     |
| `/router status`            | Alias for `/router` (show current status).                                      |
| `/router profile [name]`    | Switch to a profile or list available ones (enables router if off).             |
| `/router pin [prof] <t\|a>` | Pin a tier (high/medium/low/auto) for the current or specified profile.         |
| `/router fix <tier>`        | Correct the _last_ decision and pin that tier for the current profile.          |
| `/router thinking ...`      | Override thinking levels (e.g. `/router thinking low xhigh`).                   |
| `/router disable`           | Disable the router and switch back to the last non-router model.                |
| `/router widget <on\|off>`  | Toggle the persistent state widget (supports `toggle`).                         |
| `/router debug <on\|off>`   | Toggle turn-by-turn routing notifications (supports `toggle`, `clear`, `show`). |
| `/router reload`            | Hot-reload the configuration JSON.                                              |
| `/router help`              | Show usage help for all subcommands.                                            |

## Documentation

- [Architecture Guide](docs/ARCHITECTURE.md): Deep dive into the routing logic and modular design.
- [Sample Configuration](model-router.example.json): Diverse profile examples (`cheap`, `deep`, `balanced`).
