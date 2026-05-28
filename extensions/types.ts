import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export type RouterTier = 'high' | 'medium' | 'low';
export type RouterPin = RouterTier | 'auto';
export type RouterPhase = 'planning' | 'implementation' | 'lightweight';
export type RouterPinByProfile = Partial<Record<string, RouterTier>>;
export type RouterThinkingByTier = Partial<Record<RouterTier, ThinkingLevel>>;
export type RouterThinkingByProfile = Record<string, RouterThinkingByTier>;

export interface RoutingRule {
  matches: string | string[];
  tier: RouterTier;
  reason?: string;
}

export interface RoutedTierConfig {
  model: string;
  thinking?: ThinkingLevel;
  fallbacks?: string[];
}

export interface RouterProfile {
  high: RoutedTierConfig;
  medium: RoutedTierConfig;
  low: RoutedTierConfig;
}

export interface RouterConfig {
  defaultProfile?: string;
  debug?: boolean;
  classifierModel?: string;
  classifierModelThinking?: ThinkingLevel;
  classifierInitialContinuations?: number; // How many initial tool continuations after a user message should run the classifier. Default: 1.
  classifierFailureTrigger?: number; // How many failed tool results in a single turn trigger a classifier run. Default: 2.
  classifierCadence?: number; // Run the classifier every Nth tool continuation during long chains. Default: 10.
  phaseBias?: number;
  largeContextThreshold?: number;
  maxSessionBudget?: number;
  rules?: RoutingRule[];
  profiles: Record<string, RouterProfile>;
}

export interface RoutingDecision {
  profile: string;
  tier: RouterTier;
  phase: RouterPhase;
  targetProvider: string;
  targetModelId: string;
  targetLabel: string;
  reasoning: string;
  thinking: ThinkingLevel;
  timestamp: number;
  isClassifier?: boolean;
  isFallback?: boolean;
  isContextTriggered?: boolean;
  isBudgetForced?: boolean;
  isRuleMatched?: boolean;
  classifierContCount?: number; // Tool-continuation count at which the classifier last ran (for cadence gating)
}

export interface RouterPersistedState {
  enabled: boolean;
  selectedProfile: string;
  pinTier?: RouterTier;
  pinByProfile?: RouterPinByProfile;
  thinkingByProfile?: RouterThinkingByProfile;
  debugEnabled?: boolean;
  widgetEnabled?: boolean;
  debugHistory?: RoutingDecision[];
  lastPhase?: RouterPhase;
  lastDecision?: RoutingDecision;
  lastNonRouterModel?: string;
  accumulatedCost?: number;
  timestamp: number;
}

export interface ConfigLoadResult {
  config: RouterConfig;
  warnings: string[];
}

export interface ParsedConfigFile {
  config: Partial<RouterConfig>;
  warnings: string[];
}

export interface CustomSessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}
