# pi-model-router

Smart per-turn model router extension for the [pi-coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) that optimizes your AI budget and usage limits without sacrificing quality by dynamically routing each turn to the optimal LLM tier. It automatically selects between high, medium, and low-tier models based on task intent, session budget, context size, and custom rules — complete with automatic fallbacks and phase awareness.

## What it does

- **Native Virtual Models**: Registers each profile as a Pi [virtual model](https://pi.dev/docs/latest/virtual-models) (`router/<profile>`). Selection stays on the virtual model while each assistant message records the real physical model, preserving replay safety, native footer display, per-model `/session` cost tracking, and automatic pre-request compaction when routing to smaller-context models.
- **Per-Turn & Request-Aware Routing**: Intelligently chooses between `high`, `medium`, and `low` tiers on new user turns, stays sticky on tool-result continuations to preserve prompt caches and thinking signatures, routes background `direct` requests (like compaction summaries) cleanly, and steps through fallback chains on retries.
- **Task-Aware Heuristics**: Detects planning vs. implementation vs. lightweight tasks using keyword analysis, word count, and conversation history.
- **Advanced Controls**: Includes built-in support for:
  - **Native Classifier & LLM Intent Classification**: Supports Pi's native [classifier models](https://pi.dev/docs/latest/models#use-classifier-models) (`"auto"`, TypeSafe Jev, Cloudflare Clef / Clef Omni, OpenAI GPT-6 Luna — with image input support — and `llama.cpp` decision/logprob classifiers) with probability-aware phase bias, as well as standard chat LLMs.
  - **Custom Rules**: Define keyword-based tier overrides for specific patterns (e.g., `deploy` → `high`).
  - **Cost Budgeting**: Set a session spend limit; high tier downgrades to medium once exceeded.
  - **Fallback Chains**: Automatic fallback to alternative models if the primary model is unavailable, lacks credentials, or fails on retry.
- **Phase Memory**: Biased stickiness to keep you in the same tier during multi-turn planning or implementation work.
- **Thinking Control**: Full control over reasoning/thinking levels per tier and profile. Changing pi's thinking level (e.g. via `shift+tab`) automatically applies as an all-tier override for the active router profile.
- **Persistent State**: Pins, profiles, costs, and debug history are remembered across agent restarts and conversation branches.

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

### Basic Config Shape

```json
{
  "$schema": "https://raw.githubusercontent.com/yeliu84/pi-model-router/main/model-router.schema.json",
  "classifierModel": "auto",
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

| Field              | Description                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `$schema`          | (Optional) JSON Schema URL for editor autocompletion and validation.                                                                                                                                                                                                     |
| `classifierModel`  | (Optional) Model used to categorize intent. Supports `"auto"` (uses first available Pi native classifier such as Jev, Clef, GPT-6 Luna, or `llama.cpp`), a native classifier ID (e.g. `"typesafe/jev-latest"`), a chat LLM, or a model alias. Omit for local heuristics. |
| `maxSessionBudget` | (Optional) USD budget for the session. Forces `medium` tier once exceeded.                                                                                                                                                                                               |
| `phaseBias`        | (0.0 - 1.0) Stickiness of the current phase. Higher = more stable. Default `0.5`.                                                                                                                                                                                        |
| `rules`            | List of custom keyword rules (e.g. `{ "matches": "deploy", "tier": "high" }`).                                                                                                                                                                                           |
| `models`           | (Optional) Map of model aliases to definitions with `model`, `contextWindow`, `maxTokens`.                                                                                                                                                                               |
| `profiles`         | Map of profile definitions, each containing optional `high`, `medium`, and `low` tiers (at least one required). Tier models can reference aliases from `models`.                                                                                                         |

### Local & Custom Models (`llama.cpp`, Ollama, LM Studio)

#### 1. Using Pi's built-in `/llama` integration

If you connect a running `llama-server` instance in Pi via `/llama`, Pi registers its models under the `llama.cpp` provider. Reference them in `model-router.json` as `"llama.cpp/<model-id>"` (model IDs containing slashes, such as HuggingFace repo names, are supported):

```json
{
  "profiles": {
    "local": {
      "high": { "model": "anthropic/claude-opus-4-6" },
      "medium": { "model": "llama.cpp/Qwen3.5-27B-Q4_K_M.gguf" },
      "low": { "model": "llama.cpp/Qwen/Qwen3-Coder-Next-GGUF" }
    }
  }
}
```

#### 2. Defining local servers in `~/.pi/agent/models.json`

If you configure a custom OpenAI-compatible local provider in `~/.pi/agent/models.json` (e.g., `llama-server`, Ollama, or LM Studio), include a non-empty placeholder `"apiKey"` (such as `"local"`) in the provider entry so Pi's model registry resolves authentication for routed requests:

```json
{
  "providers": {
    "llama-local": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [
        {
          "id": "qwen3-coder",
          "name": "Qwen3 Coder (Local)",
          "contextWindow": 65536,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

Then reference `"llama-local/qwen3-coder"` in your `model-router.json` tiers or `models` aliases.

## Commands

| Command                           | Description                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/router`                         | Show detailed status, current profile, spend, and settings.                                                       |
| `/router status`                  | Alias for `/router` (show current status).                                                                        |
| `/router profile [name]`          | Switch to a profile or list available ones (enables router if off).                                               |
| `/router pin <t\|a>`              | Pin a tier (high/medium/low/auto) for the active profile.                                                         |
| `/router fix <tier>`              | Correct the _last_ decision and pin that tier for the current profile.                                            |
| `/router thinking <level>`        | Override thinking level for all tiers (e.g. `/router thinking max`). Not all tier models may support every level. |
| `/router thinking <tier> <level>` | Override thinking level for a specific tier (e.g. `/router thinking low off`).                                    |
| `/router disable`                 | Disable the router and switch back to the last non-router model.                                                  |
| `/router widget <on\|off>`        | Toggle the persistent state widget (supports `toggle`).                                                           |
| `/router debug <on\|off>`         | Toggle turn-by-turn routing notifications (supports `toggle`, `clear`, `show`).                                   |
| `/router reload`                  | Hot-reload the configuration JSON.                                                                                |
| `/router help`                    | Show usage help for all subcommands.                                                                              |

## Documentation

- [Architecture Guide](docs/ARCHITECTURE.md): Deep dive into the routing logic and modular design.
- [Sample Configuration](model-router.example.json): Diverse profile examples (`cheap`, `deep`, `balanced`).
