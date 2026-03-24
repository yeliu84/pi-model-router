import type {
  RouterPinByProfile,
  RouterThinkingByProfile,
  RoutingDecision,
  RouterPersistedState,
} from './types';

export const isRouterPersistedState = (
  value: unknown,
): value is RouterPersistedState => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as any;
  return (
    typeof v.enabled === 'boolean' &&
    typeof v.selectedProfile === 'string' &&
    typeof v.timestamp === 'number'
  );
};

export const buildPersistedState = (
  routerEnabled: boolean,
  selectedProfile: string,
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
    selectedProfile,
    pinTier: pinnedTierByProfile[selectedProfile],
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
