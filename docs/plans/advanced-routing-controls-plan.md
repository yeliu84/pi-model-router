# Advanced Routing Controls Plan

Objective: Implement five major enhancements to the `pi-model-router` to provide expert-level control, reliability, and cost management.

## 1. Custom Routing Rules
Allow users to define specific keyword-based rules that override heuristics.

### Changes
- Update `RouterConfig`: Add `rules: RoutingRule[]`.
- `interface RoutingRule { matches: string | string[]; tier: RouterTier; reason?: string; }`
- Update `decideRouting`: Check rules immediately after checking `pinnedTier`. Rules are processed in order; the first match wins.

## 2. Context-Aware Routing (The "Gemini Switch")
Automatically upgrade to the high tier when the conversation context is large.

### Changes
- Update `RouterConfig`: Add `largeContextThreshold?: number` (tokens).
- Update `registerRouterProvider`: In `streamSimple`, call `ctx.getContextUsage()`.
- If `totalTokens > threshold`, force `high` tier and set reasoning: "Context size (N) exceeded threshold (T). Forced high tier."

## 3. Fallback Chains
Improve reliability by automatically retrying failed requests with alternative models.

### Changes
- Update `RoutedTierConfig`: Add `fallbacks?: string[]` (canonical model refs).
- Update `registerRouterProvider`: Wrap the model delegation in a retry loop.
- If the primary model returns an `error` event, try the next model in the `fallbacks` list.
- Update `RoutingDecision` to track if a fallback was used.

## 4. Interactive Feedback (`/router-fix`)
Allow users to quickly correct a routing decision and provide feedback.

### Changes
- Add command: `/router-fix <high|medium|low>`.
- Logic: Applies a "corrective pin" for the remainder of the session or until the phase changes significantly.
- Future: Could log these corrections to a `feedback.json` to suggest better `phaseBias` or `rules`.

## 5. Cost-Based Budgeting
Track session costs and automatically down-tier if a budget is exceeded.

### Changes
- Update `RouterPersistedState`: Add `accumulatedCost: number`.
- Update `RouterConfig`: Add `maxSessionBudget?: number`.
- Update `registerRouterProvider`: After a turn ends, extract cost from `AssistantMessage.usage.cost.total` and add to `accumulatedCost`.
- If `accumulatedCost >= maxSessionBudget`, `decideRouting` forces the `medium` tier.
- Update `/router` and the widget to show current session spend.

## Technical Specifications

### Updated Interfaces
```typescript
interface RoutingRule {
    matches: string | string[];
    tier: RouterTier;
    reason?: string;
}

interface RoutedTierConfig {
    model: string;
    thinking?: ThinkingLevel;
    fallbacks?: string[];
}

interface RouterConfig {
    // ... existing
    largeContextThreshold?: number; // token count trigger
    maxSessionBudget?: number;      // USD trigger
    rules?: RoutingRule[];          // custom overrides
    profiles: Record<string, RouterProfile>;
}

interface RoutingDecision {
    // ... existing
    isClassifier?: boolean;
    isFallback?: boolean;
    isContextTriggered?: boolean;
    isBudgetForced?: boolean;
    isRuleMatched?: boolean;
}
```

### Logic Refinements

#### 1. Custom Rules (`decideRouting`)
Rules will be evaluated after `pinnedTier` but before heuristics or classifier.
```typescript
if (config.rules) {
    for (const rule of config.rules) {
        const matches = Array.isArray(rule.matches) ? rule.matches : [rule.matches];
        if (containsAny(prompt, matches)) {
            return buildRoutingDecision(..., rule.tier, rule.reason ?? "Matched custom rule.");
        }
    }
}
```

#### 2. Context Aware (`registerRouterProvider`)
In `streamSimple`:
```typescript
const usage = await ctx.getContextUsage();
if (currentConfig.largeContextThreshold && usage.totalTokens > currentConfig.largeContextThreshold) {
    decision = buildRoutingDecision(..., "high", "Context threshold exceeded.");
    decision.isContextTriggered = true;
}
```

#### 3. Fallback Chains (`registerRouterProvider`)
We will use a recursive or loop-based retry in `streamSimple`.
```typescript
async function delegateWithFallback(models: string[]) {
    for (const modelRef of models) {
        try {
            // attempt streaming
            // if success, break
        } catch (err) {
            if (isLastModel) throw err;
            continue; // try next fallback
        }
    }
}
```

#### 4. Cost Budgeting
Persistent state will track `accumulatedCost`. If `accumulatedCost > maxBudget`, `decideRouting` forces `medium` tier.

## Verification Plan
... (rest of verification plan)
