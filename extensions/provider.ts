import type { Api, Context, Model } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  RouterConfig,
  RoutingDecision,
  RouterTier,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RouterModelRegistry,
  RouterModelCapabilityLookup,
  VirtualRouterState,
  RouterVirtualModelDefinition,
  ModelRouteRequest,
  ModelRoute,
} from './types';
import {
  profileNames,
  parseCanonicalModelRef,
  isObjectRecord,
  ROUTER_TIERS,
  THINKING_LEVELS,
  DEFAULT_THINKING_LEVELS,
  resolveContextWindow,
  resolveMaxTokens,
  resolveThinkingLevels,
  collectProfileThinkingLevels,
  clampThinkingLevel,
} from './config';
import {
  phaseForTier,
  resolveAvailableTier,
  buildRoutingDecision,
  decideRouting,
  runClassifier,
  hasImageAttachment,
  resolveModelRequestAuth,
} from './routing';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './constants';

const REGISTRY_WAIT_TIMEOUT_MS = 5000;
const REGISTRY_WAIT_INITIAL_DELAY_MS = 50;
const REGISTRY_WAIT_MAX_DELAY_MS = 500;

const countedMessages = new WeakSet<object>();

export const markMessageCostCounted = (message: unknown): void => {
  if (isObjectRecord(message)) {
    countedMessages.add(message);
  }
};

export const extractUncountedMessageCost = (input: unknown): number => {
  if (!isObjectRecord(input)) return 0;
  const message =
    input.role === 'assistant'
      ? input
      : isObjectRecord(input.message)
        ? input.message
        : undefined;
  if (
    !message ||
    message.role !== 'assistant' ||
    countedMessages.has(message)
  ) {
    return 0;
  }
  countedMessages.add(message);
  const total =
    isObjectRecord(message.usage) && isObjectRecord(message.usage.cost)
      ? message.usage.cost.total
      : undefined;
  return typeof total === 'number' && total > 0 ? total : 0;
};

/**
 * Wait for the model registry to become available with exponential backoff.
 * Fallback for callers that invoke routing before `session_start` without a bound `ctx.modelRegistry`.
 */
export const waitForRegistry = async <TRegistry = RouterModelRegistry>(
  state: {
    readonly currentModelRegistry: TRegistry | undefined;
  },
  timeoutMs: number = REGISTRY_WAIT_TIMEOUT_MS,
): Promise<TRegistry | undefined> => {
  if (state.currentModelRegistry) return state.currentModelRegistry;

  const start = Date.now();
  let delay = REGISTRY_WAIT_INITIAL_DELAY_MS;
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (state.currentModelRegistry) return state.currentModelRegistry;
    delay = Math.min(delay * 2, REGISTRY_WAIT_MAX_DELAY_MS);
  }
  return undefined;
};

const supportsReasoning = (
  profile: RouterConfig['profiles'][string],
  modelRegistry: RouterModelCapabilityLookup | undefined,
): boolean => {
  if (!modelRegistry) return false;

  for (const tier of ROUTER_TIERS) {
    const tierConfig = profile[tier];
    if (!tierConfig) continue;
    try {
      const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
      if (modelRegistry.find(provider, modelId)?.reasoning) {
        return true;
      }
    } catch (_error) {
      // ignore invalid model refs here; config normalization handles warnings
    }
  }

  return false;
};

export interface RouterProviderState<TContext = ExtensionContext> {
  lastRegisteredModels: string;
  readonly currentConfig: RouterConfig;
  readonly currentModelRegistry: RouterModelRegistry | undefined;
  readonly lastExtensionContext: TContext | undefined;
  selectedProfile: string | undefined;
  routerEnabled: boolean;
  lastDecision: RoutingDecision | undefined;
  readonly thinkingByProfile: RouterThinkingByProfile;
  readonly pinnedTierByProfile: RouterPinByProfile;
  accumulatedCost: number;
  /** Override for the registry wait timeout (for testing). */
  readonly registryTimeoutMs?: number;
}

export interface RouterProviderActions<TContext = ExtensionContext> {
  persistState: () => void;
  recordDebugDecision: (decision: RoutingDecision) => void;
  getThinkingOverride: (
    profileName: string,
    tier: RouterTier,
  ) => ThinkingLevel | undefined;
  updateStatus: (ctx: TContext) => void;
  syncPiThinkingLevel: (level: ThinkingLevel) => void;
}

export const routeVirtualModelRequest = async <TContext = ExtensionContext>(
  request: ModelRouteRequest<VirtualRouterState>,
  ctx: TContext | undefined,
  state: RouterProviderState<TContext>,
  actions: RouterProviderActions<TContext>,
): Promise<ModelRoute<VirtualRouterState>> => {
  try {
    const ctxRegistry =
      ctx &&
      typeof ctx === 'object' &&
      'modelRegistry' in ctx &&
      ctx.modelRegistry
        ? (ctx.modelRegistry as RouterModelRegistry)
        : undefined;
    const registry =
      ctxRegistry ?? (await waitForRegistry(state, state.registryTimeoutMs));
    if (!registry) {
      throw new Error(
        'Router provider initialization timed out. session_start may not have fired.',
      );
    }

    const profileName = request.model.id;
    const profile = state.currentConfig.profiles[profileName];
    if (!profile) {
      throw new Error(`Unknown router profile: ${profileName}`);
    }

    const resolveCandidate = async (
      modelRef: string,
    ): Promise<
      | {
          ok: true;
          model: Model<Api>;
          provider: string;
          modelId: string;
        }
      | {
          ok: false;
          error: string;
        }
    > => {
      const { provider, modelId } = parseCanonicalModelRef(modelRef);
      if (provider === 'router') {
        return {
          ok: false,
          error: `Invalid routed target "${modelRef}": cannot route to virtual router provider.`,
        };
      }
      const targetModel = registry.find(provider, modelId);
      if (!targetModel) {
        return {
          ok: false,
          error: `Routed model not found: ${provider}/${modelId}`,
        };
      }
      if (
        registry.hasConfiguredAuth &&
        !registry.hasConfiguredAuth(targetModel)
      ) {
        return {
          ok: false,
          error: `No configured credentials for routed model: ${provider}/${modelId}`,
        };
      }
      const resolvedAuth = await resolveModelRequestAuth(targetModel, registry);
      if (!resolvedAuth.ok) {
        return { ok: false, error: resolvedAuth.error };
      }
      return {
        ok: true,
        model: resolvedAuth.model,
        provider,
        modelId,
      };
    };

    const resolveFirstAvailableModel = async (candidates: string[]) => {
      let lastError: unknown;
      for (let i = 0; i < candidates.length; i++) {
        const modelRef = candidates[i];
        const resolved = await resolveCandidate(modelRef);
        if (!resolved.ok) {
          lastError = new Error(resolved.error);
          continue;
        }
        return { ...resolved, modelRef, index: i };
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(
            typeof lastError === 'string'
              ? lastError
              : 'Failed to resolve any model in the routing chain.',
          );
    };

    const resolveDelegatedThinking = (
      tier: RouterTier,
      baseThinking: ThinkingLevel,
      targetModel: Model<Api>,
    ): {
      effectiveThinking: ThinkingLevel;
      delegatedThinking: ThinkingLevel;
    } => {
      const effectiveThinking =
        actions.getThinkingOverride(profileName, tier) ?? baseThinking;
      const clamped = clampThinkingLevel(
        effectiveThinking,
        resolveThinkingLevels(tier, profile, registry),
      );
      const delegatedThinking: ThinkingLevel =
        targetModel.reasoning && clamped !== 'off' ? clamped : 'off';
      return { effectiveThinking, delegatedThinking };
    };

    const pinnedTier = state.pinnedTierByProfile[profileName];
    const previousDecision =
      request.state?.lastDecision?.profile === profileName
        ? request.state.lastDecision
        : state.lastDecision?.profile === profileName
          ? state.lastDecision
          : undefined;

    // Direct requests (e.g. compaction summaries) route cleanly without mutating session state.
    // Prefer the currently active model (from previous decision) to preserve the session's
    // prompt cache, falling back to pinned tier or medium only if no active model exists.
    if (request.reason === 'direct') {
      const directTier = resolveAvailableTier(
        profile,
        pinnedTier ?? previousDecision?.tier ?? 'medium',
      );
      const tierConfig = profile[directTier]!;
      const preferredModel =
        previousDecision?.tier === directTier
          ? previousDecision.targetLabel
          : undefined;
      const candidates = [
        ...new Set([
          ...(preferredModel ? [preferredModel] : []),
          tierConfig.model,
          ...(tierConfig.fallbacks ?? []),
        ]),
      ];
      const resolved = await resolveFirstAvailableModel(candidates);
      const { delegatedThinking } = resolveDelegatedThinking(
        directTier,
        tierConfig.thinking ?? directTier,
        resolved.model,
      );
      return {
        model: resolved.model,
        thinkingLevel: delegatedThinking,
      };
    }

    // Account for any completed assistant responses not yet recorded.
    for (const msg of request.messages) {
      if (msg.role === 'assistant') {
        state.accumulatedCost += extractUncountedMessageCost(msg);
      }
    }
    if (request.failed?.message) {
      state.accumulatedCost += extractUncountedMessageCost(
        request.failed.message,
      );
    }

    state.selectedProfile = profileName;
    state.routerEnabled = true;

    const isBudgetExceeded =
      state.currentConfig.maxSessionBudget !== undefined &&
      state.accumulatedCost >= state.currentConfig.maxSessionBudget;

    const context: Context = { messages: [...request.messages] };
    const lastMessage = request.messages.findLast((m) => m.role !== 'system');
    const isContinuation =
      request.reason === 'continuation' ||
      (request.reason !== 'retry' && lastMessage?.role === 'toolResult');
    const hasChangedPinOnContinuation =
      isContinuation &&
      pinnedTier !== undefined &&
      pinnedTier !== previousDecision?.tier;

    let decision: RoutingDecision;

    if (
      (isContinuation || request.reason === 'retry') &&
      previousDecision &&
      !hasChangedPinOnContinuation
    ) {
      if (isBudgetExceeded && previousDecision.tier === 'high') {
        const downgradedTier = resolveAvailableTier(profile, 'medium');
        decision = buildRoutingDecision(
          profileName,
          profile,
          downgradedTier,
          phaseForTier(downgradedTier),
          `Budget exceeded. Downgraded from high to ${downgradedTier} tier. (Original: ${previousDecision.reasoning})`,
          state.thinkingByProfile[profileName],
          previousDecision.isClassifier,
        );
        decision.isBudgetForced = true;
      } else {
        decision = {
          ...previousDecision,
          timestamp: Date.now(),
          reasoning:
            isContinuation &&
            !previousDecision.reasoning.startsWith('Preserved ')
              ? `Preserved ${previousDecision.targetLabel} for tool-result continuation ` +
                `to maintain prompt cache and thinking state. (Original: ${previousDecision.reasoning})`
              : previousDecision.reasoning,
        };
      }
    } else {
      decision = decideRouting(
        context,
        profileName,
        profile,
        previousDecision,
        pinnedTier,
        state.thinkingByProfile[profileName],
        state.currentConfig.phaseBias,
        state.currentConfig.rules,
        isBudgetExceeded,
      );

      // Classifier Override — skip when pinned, rule-matched, or budget exceeded.
      if (
        !isContinuation &&
        state.currentConfig.classifierModel &&
        !pinnedTier &&
        !decision.isRuleMatched &&
        !isBudgetExceeded
      ) {
        const classifierResult = await runClassifier(
          state.currentConfig.classifierModel.model,
          registry,
          context,
          previousDecision?.phase,
          state.currentConfig.classifierModel.thinking,
          state.currentConfig.phaseBias,
          request.signal,
        );
        if (classifierResult?.cost) {
          state.accumulatedCost += classifierResult.cost;
        }
        if (classifierResult) {
          const classifiedTier = resolveAvailableTier(
            profile,
            classifierResult.tier,
          );
          decision = buildRoutingDecision(
            profileName,
            profile,
            classifiedTier,
            phaseForTier(classifiedTier),
            `Classifier: ${classifierResult.reasoning}`,
            state.thinkingByProfile[profileName],
            true,
          );
        }
      }
    }

    const imageAttached = hasImageAttachment(context);
    const checkModelSupportsImage = (modelRef: string) => {
      try {
        const { provider, modelId } = parseCanonicalModelRef(modelRef);
        const m = registry.find(provider, modelId);
        return m?.input?.includes('image') ?? false;
      } catch {
        return false;
      }
    };

    if (imageAttached) {
      const tierModels = [
        decision.targetLabel,
        ...(profile[decision.tier]?.fallbacks ?? []),
      ];
      if (!tierModels.some(checkModelSupportsImage)) {
        const tiersToTry: RouterTier[] =
          decision.tier === 'low'
            ? ['medium', 'high']
            : decision.tier === 'medium'
              ? ['high']
              : [];

        let foundTier: RouterTier | undefined;
        for (const t of tiersToTry) {
          const tierConfig = profile[t];
          if (!tierConfig) continue;
          const tModels = [tierConfig.model, ...(tierConfig.fallbacks ?? [])];
          if (tModels.some(checkModelSupportsImage)) {
            foundTier = t;
            break;
          }
        }

        if (foundTier) {
          decision = buildRoutingDecision(
            profileName,
            profile,
            foundTier,
            phaseForTier(foundTier),
            `Forced ${foundTier} tier because the originally routed ${decision.tier} tier does not support image attachments.`,
            state.thinkingByProfile[profileName],
            false,
          );
        }
      }
    }

    let modelsToTry = [
      ...new Set([
        decision.targetLabel,
        ...(profile[decision.tier]?.fallbacks ?? []),
      ]),
    ];
    if (imageAttached) {
      modelsToTry = modelsToTry.filter(checkModelSupportsImage);
      if (modelsToTry.length === 0) {
        modelsToTry = [decision.targetLabel];
      }
    }

    // On retry, rotate candidates so models after the failed model are attempted first.
    if (request.reason === 'retry' && request.failed?.model) {
      const failedRef = `${request.failed.model.provider}/${request.failed.model.id}`;
      const failedIdx = modelsToTry.indexOf(failedRef);
      if (failedIdx !== -1 && modelsToTry.length > 1) {
        modelsToTry = [
          ...modelsToTry.slice(failedIdx + 1),
          ...modelsToTry.slice(0, failedIdx + 1),
        ];
      }
    }

    const resolved = await resolveFirstAvailableModel(modelsToTry);
    const selectedModel = resolved.model;
    if (resolved.modelRef !== decision.targetLabel || resolved.index > 0) {
      const originalTarget = decision.targetLabel;
      decision = {
        ...decision,
        targetProvider: resolved.provider,
        targetModelId: resolved.modelId,
        targetLabel: resolved.modelRef,
        isFallback: true,
        reasoning:
          request.reason === 'retry' && request.failed
            ? `Fallback to ${resolved.modelRef} after ${request.failed.model.provider}/${request.failed.model.id} failed${request.failed.message.errorMessage ? ` (${request.failed.message.errorMessage})` : ''}. (Original: ${decision.reasoning})`
            : resolved.modelRef !== originalTarget
              ? `Fallback to ${resolved.modelRef} because ${originalTarget} was unavailable. (Original: ${decision.reasoning})`
              : decision.reasoning,
      };
    }

    const { effectiveThinking, delegatedThinking } = resolveDelegatedThinking(
      decision.tier,
      decision.thinking,
      selectedModel,
    );

    decision = {
      ...decision,
      thinking: effectiveThinking,
    };

    state.lastDecision = decision;
    actions.recordDebugDecision(decision);

    const effectiveCtx = ctx ?? state.lastExtensionContext;
    try {
      actions.syncPiThinkingLevel(effectiveThinking);
      if (effectiveCtx) {
        actions.updateStatus(effectiveCtx);
      }
    } catch {
      // Stale extension context — skip non-critical UI updates.
    }

    return {
      model: selectedModel,
      thinkingLevel: delegatedThinking,
      state: {
        phase: decision.phase,
        tier: decision.tier,
        lastDecision: decision,
      },
    };
  } finally {
    try {
      actions.persistState();
    } catch {
      // Ignore: extension context may be stale after session teardown.
    }
  }
};

export const registerRouterProvider = <TContext = ExtensionContext>(
  pi: {
    registerVirtualModel: (
      model: RouterVirtualModelDefinition<VirtualRouterState, TContext>,
    ) => void;
    unregisterVirtualModel?: (provider: string, id: string) => void;
  },
  state: RouterProviderState<TContext>,
  actions: RouterProviderActions<TContext>,
) => {
  const profileList = profileNames(state.currentConfig);

  const modelDefinitions = profileList.map((name) => {
    const profile = state.currentConfig.profiles[name];

    // Report the MAX context window and max output tokens across all tiers
    // before the first response. Afterwards, Pi uses the physical model's limits
    // and auto-compacts before sending if the routed model's context is smaller.
    let maxContextWindow = DEFAULT_CONTEXT_WINDOW;
    let maxMaxTokens = DEFAULT_MAX_TOKENS;
    for (const tier of ROUTER_TIERS) {
      if (!profile[tier]) continue;
      const cw = resolveContextWindow(
        tier,
        profile,
        state.currentModelRegistry,
      );
      const mot = resolveMaxTokens(tier, profile, state.currentModelRegistry);
      if (cw > maxContextWindow) maxContextWindow = cw;
      if (mot > maxMaxTokens) maxMaxTokens = mot;
    }

    const hasReasoning = supportsReasoning(profile, state.currentModelRegistry);
    const profileLevels = collectProfileThinkingLevels(
      profile,
      state.currentModelRegistry,
    );
    const thinkingLevels: ThinkingLevel[] = hasReasoning
      ? THINKING_LEVELS.filter(
          (level) =>
            level === 'off' ||
            profileLevels.has(level) ||
            (profileLevels.size === 0 &&
              DEFAULT_THINKING_LEVELS.includes(level)),
        )
      : ['off'];

    return {
      id: name,
      name: `Router ${name}`,
      reasoning: hasReasoning,
      thinkingLevels,
      input: ['text', 'image'] as ('text' | 'image')[],
      contextWindow: maxContextWindow,
      maxTokens: maxMaxTokens,
    };
  });

  const modelsKey = modelDefinitions
    .map(
      (m) =>
        `${m.id}:${m.contextWindow}:${m.maxTokens}:${m.reasoning}:${m.thinkingLevels.join('|')}`,
    )
    .join(',');
  if (state.lastRegisteredModels === modelsKey) return;

  const previousIds = state.lastRegisteredModels
    ? state.lastRegisteredModels
        .split(',')
        .map((entry) => entry.split(':')[0])
        .filter(Boolean)
    : [];
  for (const prevId of previousIds) {
    if (!profileList.includes(prevId)) {
      pi.unregisterVirtualModel?.('router', prevId);
    }
  }

  for (const def of modelDefinitions) {
    pi.registerVirtualModel({
      provider: 'router',
      id: def.id,
      name: def.name,
      thinkingLevels: def.thinkingLevels,
      contextWindow: def.contextWindow,
      maxTokens: def.maxTokens,
      input: def.input,
      route: (request, ctx) =>
        routeVirtualModelRequest(request, ctx, state, actions),
    });
  }

  state.lastRegisteredModels = modelsKey;
};
