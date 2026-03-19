# Architecture: Pi Model Router Extension

The `pi-model-router` extension provides intelligent, automated model selection for the `pi` coding agent. It optimizes for cost, speed, and intelligence by routing different types of prompts to the most appropriate Large Language Model (LLM).

## Core Concepts

### 1. Model Groups
Models are categorized into groups based on their capabilities:
- **Fast**: Small, fast, inexpensive models (e.g., GPT-4o-mini, Claude Haiku). Ideal for simple explanations, summaries, and small code tweaks.
- **Smart**: High-capability coding models (e.g., Claude 3.5 Sonnet, GPT-4o). The default for most implementation tasks.
- **Reasoning**: Models with extended thinking/O1-style capabilities (e.g., OpenAI o1, Claude with high thinking). Best for complex architecture, deep debugging, and planning.
- **Large Context**: Models with massive context windows (e.g., Gemini 1.5 Pro). Routed to when many large files are in context.

### 2. Routing Logic
Routing decisions are made using a multi-stage approach:
1. **Manual Override**: If the user has explicitly set a model in the current turn, the router respects it.
2. **Context Trigger**: If the current context size exceeds a threshold (e.g., 100k tokens), route to a **Large Context** model.
3. **Intent Classification**:
   - **Heuristics**: Fast regex matching for obvious keywords (e.g., "summarize", "plan").
   - **LLM Classifier**: (Optional) Use a **Fast** model to categorize the user's intent if heuristics are ambiguous.
4. **Fallback**: If the preferred model's provider is known to be down or returning errors, route to an equivalent model in another group.

## Components

### 1. Configuration (`router.json`)
Allows users to define their own groups and rules.
```json
{
  "enabled": true,
  "groups": {
    "fast": { "provider": "openai", "model": "gpt-4o-mini" },
    "smart": { "provider": "anthropic", "model": "claude-3-5-sonnet-20241022" },
    "reasoning": { "provider": "openai", "model": "o1-preview" }
  },
  "rules": [
    { "intent": "planning", "group": "reasoning", "keywords": ["plan", "architecture", "design"] },
    { "intent": "simple", "group": "fast", "keywords": ["explain", "summarize", "what is"] }
  ],
  "defaultGroup": "smart"
}
```

### 2. The Router Extension (`index.ts`)
Hooks into the `pi` lifecycle:
- `session_start`: Loads configuration and initializes state.
- `before_agent_start`: The primary interception point. Analyzes the prompt and context, then calls `pi.setModel()` if a switch is needed.
- `model_select`: Tracks if a model was changed manually to avoid fighting the user.
- `turn_end`: Records performance metadata (latency, cost) to help refine routing rules.

### 3. Intent Classifier (`classifier.ts`)
Encapsulates the logic for determining what the user wants to do.
- `matchHeuristics(prompt)`: Returns a group if a keyword matches.
- `classifyWithLLM(prompt)`: Asks a fast model to pick a group.

## User Interface

### 1. Notifications
The router notifies the user when it changes the model:
> 🔄 **Router**: Switched to `claude-3-5-sonnet` (Smart) for implementation task.

### 2. Commands
- `/router on|off`: Toggle auto-routing.
- `/router list`: Show defined groups and rules.
- `/router status`: Show current active group and why it was chosen.

### 3. Status Bar
Displays the current routing mode and active group:
`[Router: Auto (Smart)]`

## Implementation Strategy

1. **Phase 1: Basic Heuristics**. Implement the extension with keyword-based routing and manual overrides.
2. **Phase 2: Context-Awareness**. Add logic to check context usage via `ctx.getContextUsage()` and route to large-context models.
3. **Phase 3: LLM Classification**. Implement the optional small-LLM call for high-accuracy routing.
4. **Phase 4: Analytics & Refinement**. Add turn-over-turn logging to visualize how often each model is used and the associated costs.
