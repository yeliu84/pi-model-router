import type {
  RouterPinByProfile,
  RouterThinkingByProfile,
  RoutingDecision,
  RouterPersistedState,
  VirtualRouterState,
} from './types';

const normalizeDecisionForSnapshot = (
  decision: RoutingDecision,
): RoutingDecision => ({
  profile: decision.profile,
  tier: decision.tier,
  phase: decision.phase,
  targetProvider: decision.targetProvider,
  targetModelId: decision.targetModelId,
  targetLabel: decision.targetLabel,
  reasoning: decision.reasoning,
  thinking: decision.thinking,
  timestamp: 0,
  isClassifier: Boolean(decision.isClassifier),
  isFallback: Boolean(decision.isFallback),
  isBudgetForced: Boolean(decision.isBudgetForced),
  isRuleMatched: Boolean(decision.isRuleMatched),
});

export const serializePersistedStateSnapshot = (
  persisted: RouterPersistedState,
): string =>
  JSON.stringify({
    ...persisted,
    timestamp: 0,
    lastDecision: persisted.lastDecision
      ? normalizeDecisionForSnapshot(persisted.lastDecision)
      : undefined,
    debugHistory: persisted.debugHistory
      ?.filter((d): d is RoutingDecision => Boolean(d))
      .map(normalizeDecisionForSnapshot),
  });

export const isSameVirtualRouterState = (
  prev: VirtualRouterState | undefined,
  next: VirtualRouterState,
): boolean =>
  prev?.lastDecision !== undefined &&
  prev.lastDecision !== null &&
  prev.phase === next.phase &&
  prev.tier === next.tier &&
  JSON.stringify(normalizeDecisionForSnapshot(prev.lastDecision)) ===
    JSON.stringify(normalizeDecisionForSnapshot(next.lastDecision));

export const isRouterPersistedState = (
  value: unknown,
): value is RouterPersistedState => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.enabled === 'boolean' &&
    typeof v.selectedProfile === 'string' &&
    typeof v.timestamp === 'number'
  );
};

export const buildPersistedState = (
  routerEnabled: boolean,
  selectedProfile: string | undefined,
  pinnedTierByProfile: RouterPinByProfile,
  thinkingByProfile: RouterThinkingByProfile,
  debugEnabled: boolean,
  widgetEnabled: boolean,
  debugHistory: RoutingDecision[],
  lastDecision: RoutingDecision | undefined,
  lastNonRouterModel: string | undefined,
  accumulatedCost: number,
): RouterPersistedState => {
  return {
    enabled: routerEnabled,
    selectedProfile: selectedProfile ?? '',
    pinTier: selectedProfile ? pinnedTierByProfile[selectedProfile] : undefined,
    pinByProfile: { ...pinnedTierByProfile },
    thinkingByProfile: { ...thinkingByProfile },
    debugEnabled,
    widgetEnabled,
    debugHistory,
    lastPhase: lastDecision?.phase,
    lastDecision,
    lastNonRouterModel,
    accumulatedCost,
    timestamp: Date.now(),
  };
};
