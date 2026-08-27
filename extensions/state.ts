import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type {
  RouterLastProfileState,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RoutingDecision,
  RouterPersistedState,
} from './types';

const LAST_PROFILE_STATE_FILE = 'model-router-state.json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isRouterLastProfileState = (
  value: unknown,
): value is RouterLastProfileState =>
  isRecord(value) &&
  typeof value.selectedProfile === 'string' &&
  value.selectedProfile.length > 0 &&
  typeof value.timestamp === 'number';

export const loadLastRouterProfile = (
  agentDir = getAgentDir(),
): string | undefined => {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(agentDir, LAST_PROFILE_STATE_FILE), 'utf8'),
    );
    return isRouterLastProfileState(value) ? value.selectedProfile : undefined;
  } catch {
    return undefined;
  }
};

export const saveLastRouterProfile = (
  selectedProfile: string,
  agentDir = getAgentDir(),
): boolean => {
  const state: RouterLastProfileState = {
    selectedProfile,
    timestamp: Date.now(),
  };
  try {
    writeFileSync(
      join(agentDir, LAST_PROFILE_STATE_FILE),
      `${JSON.stringify(state, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
};

export const isRouterPersistedState = (
  value: unknown,
): value is RouterPersistedState => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.enabled === 'boolean' &&
    typeof value.selectedProfile === 'string' &&
    typeof value.timestamp === 'number'
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
