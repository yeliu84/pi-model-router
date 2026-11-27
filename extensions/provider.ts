import {
  isContextOverflow,
  type Api,
  type Context,
  type Message,
  type Model,
} from '@earendil-works/pi-ai';
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
  ModelCooldownEntry,
  CustomSessionEntry,
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
  getUnsupportedTiers,
  clampThinkingLevel,
} from './config';
import {
  phaseForTier,
  resolveAvailableTier,
  buildRoutingDecision,
  decideRouting,
  runClassifier,
  hasImageAttachment,
  resolveTurnUserMessage,
} from './routing';
import { isSameVirtualRouterState } from './state';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  MIN_RATE_LIMIT_COOLDOWN_MS,
  MAX_RATE_LIMIT_COOLDOWN_MS,
} from './constants';

let countedObjects = new WeakSet<object>();

export const resetCountedMessageCosts = (): void => {
  countedObjects = new WeakSet<object>();
};

const isBillableUsageRecord = (value: Record<string, unknown>): boolean =>
  value.role === 'assistant' ||
  value.role === 'toolResult' ||
  value.type === 'compaction' ||
  value.type === 'branch_summary' ||
  value.type === 'usage';

const extractSingleUsageCost = (item: unknown): number => {
  if (!isObjectRecord(item)) return 0;
  if (item.type === 'message') {
    return extractSingleUsageCost(item.message);
  }
  if (!isBillableUsageRecord(item) || countedObjects.has(item)) {
    return 0;
  }
  countedObjects.add(item);
  const total =
    isObjectRecord(item.usage) && isObjectRecord(item.usage.cost)
      ? item.usage.cost.total
      : undefined;
  return typeof total === 'number' && total > 0 ? total : 0;
};

export const extractUncountedMessageCost = (input: unknown): number => {
  if (!isObjectRecord(input)) return 0;
  if (isBillableUsageRecord(input) || input.type === 'message') {
    return extractSingleUsageCost(input);
  }
  const items = [
    input.message,
    ...(Array.isArray(input.toolResults) ? input.toolResults : []),
    input.compactionEntry,
    input.summaryEntry,
  ];
  let cost = 0;
  for (const item of items) {
    cost += extractSingleUsageCost(item);
  }
  return cost;
};

export const markMessageCostCounted = (input: unknown): void => {
  extractUncountedMessageCost(input);
};

const getCaseInsensitiveHeader = (
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined => {
  if (!headers) return undefined;
  if (name in headers) return headers[name];
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
};

const clampCooldownMs = (ms: number): number =>
  Math.min(
    MAX_RATE_LIMIT_COOLDOWN_MS,
    Math.max(MIN_RATE_LIMIT_COOLDOWN_MS, Math.ceil(ms)),
  );

export const parseRetryAfterMs = (
  headers: Record<string, string> | undefined,
  now = Date.now(),
): number | undefined => {
  const retryAfterMsRaw = getCaseInsensitiveHeader(
    headers,
    'retry-after-ms',
  )?.trim();
  if (retryAfterMsRaw) {
    const ms = Number(retryAfterMsRaw);
    if (Number.isFinite(ms) && ms > 0) return clampCooldownMs(ms);
  }

  const retryAfterRaw = getCaseInsensitiveHeader(
    headers,
    'retry-after',
  )?.trim();
  if (retryAfterRaw) {
    const seconds = Number(retryAfterRaw);
    const delayMs = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfterRaw) - now;
    if (Number.isFinite(delayMs) && delayMs > 0)
      return clampCooldownMs(delayMs);
  }

  return undefined;
};

export const pruneExpiredCooldowns = (
  cooldowns: Map<string, ModelCooldownEntry> | undefined,
  now = Date.now(),
): void => {
  if (!cooldowns) return;
  for (const [modelRef, entry] of cooldowns) {
    if (entry.until <= now) {
      cooldowns.delete(modelRef);
    }
  }
};

export const getActiveCooldownRemainingMs = (
  cooldowns: ReadonlyMap<string, ModelCooldownEntry> | undefined,
  modelRef: string,
  now = Date.now(),
): number => {
  const entry = cooldowns?.get(modelRef);
  return entry && entry.until > now ? entry.until - now : 0;
};

export const applyProviderResponseCooldown = (
  cooldowns: Map<string, ModelCooldownEntry>,
  modelRef: string | undefined,
  status: number,
  headers: Record<string, string> | undefined,
  now = Date.now(),
): boolean => {
  pruneExpiredCooldowns(cooldowns, now);
  if (!modelRef || modelRef.startsWith('router/')) {
    return false;
  }
  if (status >= 200 && status < 300) {
    return cooldowns.delete(modelRef);
  }
  if (status === 429 || status === 503 || status === 529) {
    const headerDelay = parseRetryAfterMs(headers, now);
    const delayMs =
      headerDelay ??
      (status === 429 || status === 529
        ? DEFAULT_RATE_LIMIT_COOLDOWN_MS
        : undefined);
    if (!delayMs) return false;
    const nextUntil = Math.max(
      cooldowns.get(modelRef)?.until ?? 0,
      now + delayMs,
    );
    cooldowns.set(modelRef, { until: nextUntil, status });
    return true;
  }
  return false;
};

const estimateMessagesTokens = (messages: readonly Message[]): number => {
  let chars = 0;
  let images = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
      continue;
    }
    for (const part of msg.content) {
      if (part.type === 'text') chars += part.text.length;
      else if (part.type === 'thinking' && !part.redacted)
        chars += part.thinking.length;
      else if (part.type === 'toolCall')
        chars += part.name.length + JSON.stringify(part.arguments).length;
      else if (part.type === 'image') images++;
    }
  }
  return Math.ceil(chars / 4) + images * 1200;
};

const preferCandidates = (
  candidates: string[],
  predicate: (ref: string) => boolean,
): string[] => {
  if (candidates.length <= 1) return candidates;
  const preferred: string[] = [];
  const rest: string[] = [];
  for (const candidate of candidates) {
    (predicate(candidate) ? preferred : rest).push(candidate);
  }
  return preferred.length > 0 ? [...preferred, ...rest] : candidates;
};

const formatModelSwitchReasoning = (
  resolvedRef: string,
  tier: RouterTier,
  originalTarget: string,
  baseReasoning: string,
  reason: ModelRouteRequest<VirtualRouterState>['reason'],
  failed: ModelRouteRequest<VirtualRouterState>['failed'],
  preCooldownFirst: string | undefined,
  preCooldownRemainingMs: number,
  isPrimaryRecovery: boolean,
): string => {
  if (reason === 'retry' && failed) {
    const errSuffix = failed.message.errorMessage
      ? ` (${failed.message.errorMessage})`
      : '';
    return `Fallback to ${resolvedRef} after ${failed.model.provider}/${failed.model.id} failed${errSuffix}. (Original: ${baseReasoning})`;
  }
  if (isPrimaryRecovery) {
    return `Recovered primary ${resolvedRef} for ${tier} tier. (Original: ${baseReasoning})`;
  }
  if (
    preCooldownFirst &&
    preCooldownRemainingMs > 0 &&
    resolvedRef !== preCooldownFirst
  ) {
    const secs = Math.ceil(preCooldownRemainingMs / 1000);
    return `Fallback to ${resolvedRef} while ${preCooldownFirst} is cooling down (${secs}s remaining). (Original: ${baseReasoning})`;
  }
  if (preCooldownFirst && resolvedRef !== preCooldownFirst) {
    return `Fallback to ${resolvedRef} because ${preCooldownFirst} was unavailable. (Original: ${baseReasoning})`;
  }
  if (resolvedRef !== originalTarget) {
    return `Preserved fallback ${resolvedRef} for ${tier} tier. (Original: ${baseReasoning})`;
  }
  return baseReasoning;
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

const resolveVirtualThinkingLevels = (
  profile: RouterConfig['profiles'][string],
  modelRegistry: RouterModelCapabilityLookup | undefined,
): ThinkingLevel[] => {
  if (!supportsReasoning(profile, modelRegistry)) return ['off'];
  const profileLevels = collectProfileThinkingLevels(profile, modelRegistry);
  const configuredTierCount = ROUTER_TIERS.filter((tier) =>
    Boolean(profile[tier]),
  ).length;
  const anyTierSupportsOff =
    getUnsupportedTiers(profile, 'off', modelRegistry).length <
    configuredTierCount;
  const levels = THINKING_LEVELS.filter(
    (level) =>
      (level === 'off' && anyTierSupportsOff) ||
      profileLevels.has(level) ||
      (profileLevels.size === 0 && DEFAULT_THINKING_LEVELS.includes(level)),
  );
  return levels.length > 0 ? levels : ['off'];
};

const getTierModels = (
  profile: RouterConfig['profiles'][string],
  tier: RouterTier,
  preferredModel?: string,
): string[] => {
  const tierConfig = profile[tier];
  if (!tierConfig) return preferredModel ? [preferredModel] : [];
  const base = [
    ...new Set([tierConfig.model, ...(tierConfig.fallbacks ?? [])]),
  ];
  if (!preferredModel) return base;
  const preferredIdx = base.indexOf(preferredModel);
  if (preferredIdx === -1) return [preferredModel, ...base];
  if (preferredIdx === 0) return base;
  return [...base.slice(preferredIdx), ...base.slice(0, preferredIdx)];
};

const resolveVirtualInputModalities = (
  profile: RouterConfig['profiles'][string],
  modelRegistry: RouterModelCapabilityLookup | undefined,
): ('text' | 'image')[] => {
  if (!modelRegistry) return ['text', 'image'];
  const refs = ROUTER_TIERS.flatMap((tier) => getTierModels(profile, tier));
  if (refs.length === 0) return ['text', 'image'];
  const anySupportsImage = refs.some((ref) => {
    const resolved = findModelByRef(ref, modelRegistry);
    return !resolved || Boolean(resolved.input?.includes('image'));
  });
  return anySupportsImage ? ['text', 'image'] : ['text'];
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
  modelCooldowns?: Map<string, ModelCooldownEntry>;
  inFlightModelRef?: string;
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

    const now = Date.now();
    pruneExpiredCooldowns(state.modelCooldowns, now);

    const deprioritizeCooledDownModels = (candidates: string[]): string[] =>
      !state.modelCooldowns || state.modelCooldowns.size === 0
        ? candidates
        : preferCandidates(
            candidates,
            (ref) =>
              getActiveCooldownRemainingMs(state.modelCooldowns, ref, now) ===
              0,
          );

    const effectiveCtx = ctx ?? state.lastExtensionContext;
    const ctxSessionManager =
      effectiveCtx &&
      typeof effectiveCtx === 'object' &&
      'sessionManager' in effectiveCtx &&
      isObjectRecord(effectiveCtx.sessionManager)
        ? (effectiveCtx.sessionManager as {
            getBranch?: () => readonly CustomSessionEntry[];
            getSessionId?: () => string;
          })
        : undefined;
    const sessionId = ctxSessionManager?.getSessionId?.();

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
      const candidates = deprioritizeCooledDownModels(
        getTierModels(
          profile,
          directTier,
          previousDecision?.tier === directTier
            ? previousDecision.targetLabel
            : undefined,
        ),
      );
      const resolved = resolveFirstAvailableModel(candidates);
      state.inFlightModelRef = resolved.modelRef;
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
    const turnUserMessage = resolveTurnUserMessage(
      context,
      ctxSessionManager?.getBranch?.(),
    );
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
        turnUserMessage,
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
          {
            signal: request.signal,
            sessionId,
            userMessage: turnUserMessage,
          },
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

    const preferredForImageCheck =
      previousDecision?.tier === decision.tier
        ? previousDecision.targetLabel
        : decision.targetLabel;

    if (
      imageAttached &&
      !getTierModels(profile, decision.tier, preferredForImageCheck).some(
        checkModelSupportsImage,
      )
    ) {
      const currentTierIdx = ROUTER_TIERS.indexOf(decision.tier);
      const higherTiers = ROUTER_TIERS.slice(
        0,
        currentTierIdx,
      ).reverse() as RouterTier[];
      const lowerTiers = ROUTER_TIERS.slice(currentTierIdx + 1) as RouterTier[];
      const foundTier = [...higherTiers, ...lowerTiers].find((t) =>
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

    const isFirstTurnForProfile =
      !isContinuation &&
      request.reason !== 'retry' &&
      !previousDecision &&
      !pinnedTier;
    if (state.currentConfig.autoPinFirstTurnDecision && isFirstTurnForProfile) {
      state.pinnedTierByProfile[profileName] = decision.tier;
      decision = {
        ...decision,
        reasoning: `${decision.reasoning} (Auto-pinned to ${decision.tier} tier from first turn.)`,
      };
    }

    const preferredModel =
      previousDecision?.tier === decision.tier
        ? previousDecision.targetLabel
        : decision.targetLabel;

    let modelsToTry = getTierModels(profile, decision.tier, preferredModel);
    if (imageAttached) {
      modelsToTry = modelsToTry.filter(checkModelSupportsImage);
      if (modelsToTry.length === 0) {
        modelsToTry = [preferredModel];
      }
    }

    let isContextRecoveryRetry = false;
    if (request.reason === 'retry' && request.failed?.model) {
      const failedRef = `${request.failed.model.provider}/${request.failed.model.id}`;
      const isContextRecovery =
        request.failed.message.stopReason === 'length' ||
        isContextOverflow(
          request.failed.message,
          request.failed.model.contextWindow,
        );
      const estimatedTokens = estimateMessagesTokens(request.messages);
      const stillExceedsFailedWindow =
        request.failed.model.contextWindow > 0 &&
        estimatedTokens > request.failed.model.contextWindow * 0.9;

      if (isContextRecovery && !stillExceedsFailedWindow) {
        // Pi already compacted the transcript to recover for failedRef; keep the active model
        // instead of rotating onto a fallback.
        isContextRecoveryRetry = true;
        const failedIdx = modelsToTry.indexOf(failedRef);
        if (failedIdx > 0) {
          modelsToTry = [
            failedRef,
            ...modelsToTry.slice(0, failedIdx),
            ...modelsToTry.slice(failedIdx + 1),
          ];
        }
      } else {
        // Rotate candidates so models after the failed model are attempted first.
        const failedIdx = modelsToTry.indexOf(failedRef);
        if (failedIdx !== -1 && modelsToTry.length > 1) {
          modelsToTry = [
            ...modelsToTry.slice(failedIdx + 1),
            ...modelsToTry.slice(0, failedIdx + 1),
          ];
        }
        if (stillExceedsFailedWindow) {
          modelsToTry = preferCandidates(modelsToTry, (ref) => {
            const cw = findModelByRef(ref, registry)?.contextWindow ?? 0;
            return cw === 0 || estimatedTokens <= cw * 0.9;
          });
        }
      }
    }

    const preCooldownFirst = modelsToTry[0];
    const preCooldownRemainingMs =
      !isContinuation && preCooldownFirst
        ? getActiveCooldownRemainingMs(
            state.modelCooldowns,
            preCooldownFirst,
            now,
          )
        : 0;
    if (!isContinuation) {
      modelsToTry = deprioritizeCooledDownModels(modelsToTry);
    }

    const resolved = resolveFirstAvailableModel(modelsToTry);
    const selectedModel = resolved.model;
    state.inFlightModelRef = resolved.modelRef;

    const isFallbackTarget =
      resolved.modelRef !== profile[decision.tier]?.model;

    if (
      isContextRecoveryRetry &&
      request.failed &&
      resolved.modelRef ===
        `${request.failed.model.provider}/${request.failed.model.id}`
    ) {
      const baseReasoning = decision.reasoning.replace(
        /^Retrying [^\s]+ after context compaction recovery\. \(Original: (.*)\)$/s,
        '$1',
      );
      decision = {
        ...decision,
        targetProvider: resolved.provider,
        targetModelId: resolved.modelId,
        targetLabel: resolved.modelRef,
        isFallback: isFallbackTarget ? true : undefined,
        reasoning: `Retrying ${resolved.modelRef} after context compaction recovery. (Original: ${baseReasoning})`,
      };
    } else if (resolved.modelRef !== decision.targetLabel) {
      const originalTarget = decision.targetLabel;
      decision = {
        ...decision,
        targetProvider: resolved.provider,
        targetModelId: resolved.modelId,
        targetLabel: resolved.modelRef,
        isFallback: isFallbackTarget ? true : undefined,
        reasoning: formatModelSwitchReasoning(
          resolved.modelRef,
          decision.tier,
          originalTarget,
          decision.reasoning,
          request.reason,
          request.failed,
          preCooldownFirst,
          preCooldownRemainingMs,
          !isFallbackTarget && Boolean(decision.isFallback),
        ),
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

    try {
      actions.syncPiThinkingLevel(effectiveThinking);
      if (effectiveCtx) {
        actions.updateStatus(effectiveCtx);
      }
    } catch {
      // Stale extension context — skip non-critical UI updates.
    }

    const nextState: VirtualRouterState = {
      phase: decision.phase,
      tier: decision.tier,
      lastDecision: decision,
    };

    return {
      model: selectedModel,
      thinkingLevel: delegatedThinking,
      state: isSameVirtualRouterState(request.state, nextState)
        ? request.state
        : nextState,
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

    const thinkingLevels = resolveVirtualThinkingLevels(
      profile,
      state.currentModelRegistry,
    );
    const input = resolveVirtualInputModalities(
      profile,
      state.currentModelRegistry,
    );

    return {
      id: name,
      name: `Router ${name}`,
      thinkingLevels,
      input,
      contextWindow: maxContextWindow,
      maxTokens: maxMaxTokens,
    };
  });

  const modelsKey = modelDefinitions
    .map(
      (m) =>
        `${m.id}:${m.contextWindow}:${m.maxTokens}:${m.thinkingLevels.join('|')}:${m.input.join('|')}`,
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
