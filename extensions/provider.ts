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
  findModelByRef,
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
} from './routing';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './constants';

const countedMessages = new WeakSet<object>();

export const markMessageCostCounted = (message: unknown): void => {
  if (isObjectRecord(message)) {
    countedMessages.add(message);
  }
};

const extractSingleMessageCost = (message: unknown): number => {
  if (
    !isObjectRecord(message) ||
    (message.role !== 'assistant' && message.role !== 'toolResult') ||
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

export const extractUncountedMessageCost = (input: unknown): number => {
  if (!isObjectRecord(input)) return 0;
  if (input.role === 'assistant' || input.role === 'toolResult') {
    return extractSingleMessageCost(input);
  }
  let cost = extractSingleMessageCost(input.message);
  if (Array.isArray(input.toolResults)) {
    for (const toolResult of input.toolResults) {
      cost += extractSingleMessageCost(toolResult);
    }
  }
  return cost;
};

const supportsReasoning = (
  profile: RouterConfig['profiles'][string],
  modelRegistry: RouterModelCapabilityLookup | undefined,
): boolean =>
  ROUTER_TIERS.some((tier) =>
    modelRegistry
      ? findModelByRef(profile[tier]?.model, modelRegistry)?.reasoning
      : profile[tier] && profile[tier].reasoning !== false,
  );

const getTierModels = (
  profile: RouterConfig['profiles'][string],
  tier: RouterTier,
  preferredModel?: string,
): string[] => {
  const tierConfig = profile[tier];
  if (!tierConfig) return preferredModel ? [preferredModel] : [];
  return [
    ...new Set([
      ...(preferredModel ? [preferredModel] : []),
      tierConfig.model,
      ...(tierConfig.fallbacks ?? []),
    ]),
  ];
};

const inferDecisionFromPrevious = (
  profileName: string,
  profile: RouterConfig['profiles'][string],
  previous: ModelRouteRequest<VirtualRouterState>['previous'],
  thinkingOverrides?: RouterThinkingByProfile[string],
): RoutingDecision | undefined => {
  if (!previous) return undefined;
  const targetRef = `${previous.model.provider}/${previous.model.id}`;
  const tier = ROUTER_TIERS.find((t) =>
    getTierModels(profile, t).includes(targetRef),
  );
  if (!tier) return undefined;
  const decision = buildRoutingDecision(
    profileName,
    profile,
    tier,
    phaseForTier(tier),
    `Inferred ${tier} tier from previous response (${targetRef}).`,
    thinkingOverrides,
  );
  return {
    ...decision,
    targetProvider: previous.model.provider,
    targetModelId: previous.model.id,
    targetLabel: targetRef,
    thinking:
      thinkingOverrides?.[tier] ?? previous.thinkingLevel ?? decision.thinking,
    ...(profile[tier]?.model !== targetRef ? { isFallback: true } : {}),
  };
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
}

export interface RouterProviderActions<TContext = ExtensionContext> {
  persistState: () => void;
  recordDebugDecision: (decision: RoutingDecision) => void;
  getThinkingOverride: (
    profileName: string,
    tier: RouterTier,
  ) => ThinkingLevel | undefined;
  updateStatus: (ctx: TContext) => void;
  syncPiThinkingLevel: (level: ThinkingLevel | undefined) => void;
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
    const registry = ctxRegistry ?? state.currentModelRegistry;
    if (!registry) {
      throw new Error('Router model registry is unavailable.');
    }

    const profileName = request.model.id;
    const profile = state.currentConfig.profiles[profileName];
    if (!profile) {
      throw new Error(`Unknown router profile: ${profileName}`);
    }

    const resolveCandidate = (
      modelRef: string,
    ):
      | {
          ok: true;
          model: Model<Api>;
          provider: string;
          modelId: string;
        }
      | {
          ok: false;
          error: string;
        } => {
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
      return {
        ok: true,
        model: targetModel,
        provider,
        modelId,
      };
    };

    const resolveFirstAvailableModel = (candidates: string[]) => {
      let lastError: unknown;
      for (let i = 0; i < candidates.length; i++) {
        const modelRef = candidates[i];
        const resolved = resolveCandidate(modelRef);
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
        resolveThinkingLevels(tier, profile, registry, targetModel),
        targetModel.thinkingLevelMap?.off !== null,
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
          : inferDecisionFromPrevious(
              profileName,
              profile,
              request.previous,
              state.thinkingByProfile[profileName],
            );

    // Direct requests (e.g. compaction summaries) route cleanly without mutating session state.
    // Prefer the currently active model (from previous decision) to preserve the session's
    // prompt cache, falling back to pinned tier or medium only if no active model exists.
    if (request.reason === 'direct') {
      const directTier = resolveAvailableTier(
        profile,
        pinnedTier ?? previousDecision?.tier ?? 'medium',
      );
      const tierConfig = profile[directTier]!;
      const candidates = getTierModels(
        profile,
        directTier,
        previousDecision?.tier === directTier
          ? previousDecision.targetLabel
          : undefined,
      );
      const resolved = resolveFirstAvailableModel(candidates);
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

    // Account for any completed assistant or toolResult (e.g. codemode) usage not yet recorded.
    for (const msg of request.messages) {
      state.accumulatedCost += extractUncountedMessageCost(msg);
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
    const checkModelSupportsImage = (modelRef: string) =>
      findModelByRef(modelRef, registry)?.input?.includes('image') ?? false;

    if (
      imageAttached &&
      !getTierModels(profile, decision.tier, decision.targetLabel).some(
        checkModelSupportsImage,
      )
    ) {
      const higherTiers = ROUTER_TIERS.slice(
        0,
        ROUTER_TIERS.indexOf(decision.tier),
      ).reverse() as RouterTier[];
      const foundTier = higherTiers.find((t) =>
        getTierModels(profile, t).some(checkModelSupportsImage),
      );
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

    let modelsToTry = getTierModels(
      profile,
      decision.tier,
      decision.targetLabel,
    );
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

    const resolved = resolveFirstAvailableModel(modelsToTry);
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
      thinkingLevels,
      input: ['text', 'image'] as ('text' | 'image')[],
      contextWindow: maxContextWindow,
      maxTokens: maxMaxTokens,
    };
  });

  const modelsKey = modelDefinitions
    .map(
      (m) =>
        `${m.id}:${m.contextWindow}:${m.maxTokens}:${m.thinkingLevels.join('|')}`,
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
