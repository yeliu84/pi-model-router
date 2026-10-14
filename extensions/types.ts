import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

export type RouterTier = 'high' | 'medium' | 'low';
export type RouterPin = RouterTier | 'auto';
export type RouterPhase = 'planning' | 'implementation' | 'lightweight';
export type RouterPinByProfile = Partial<Record<string, RouterTier>>;
export type RouterThinkingByTier = Partial<Record<RouterTier, ThinkingLevel>>;
export type RouterThinkingByProfile = Record<string, RouterThinkingByTier>;

export interface RouterModelCapabilityLookup {
  find: (
    provider: string,
    modelId: string,
  ) =>
    | {
        contextWindow?: number;
        maxTokens?: number;
        reasoning?: boolean;
        thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
        input?: readonly string[];
      }
    | undefined;
}

export type RouterModelLookup = Pick<ExtensionContext['modelRegistry'], 'find'>;

export type RouterModelRegistry = Pick<
  ExtensionContext['modelRegistry'],
  'find' | 'getApiKeyAndHeaders'
> &
  Partial<
    Pick<ExtensionContext['modelRegistry'], 'getRegisteredProviderConfig'>
  >;

export type ResolvedModelRequest =
  | {
      ok: true;
      model: Model<Api>;
      streamOptions: Pick<SimpleStreamOptions, 'apiKey' | 'headers' | 'env'>;
    }
  | {
      ok: false;
      error: string;
    };

export interface RouterUIContext {
  ui: {
    setStatus: (key: string, text: string | undefined) => void;
    setWidget: (key: string, content: string[] | undefined) => void;
    theme: {
      fg: (color: 'dim', text: string) => string;
    };
  };
}

export interface RouterCommandContext {
  ui: {
    notify: (message: string, type?: 'info' | 'warning' | 'error') => void;
    setStatus: (key: string, text: string | undefined) => void;
    setWidget: (key: string, content: string[] | undefined) => void;
  };
  modelRegistry: RouterModelLookup;
  model: Pick<Model<Api>, 'provider' | 'id'> | undefined;
}

export interface RouterExtensionContext extends RouterUIContext {
  cwd: string;
  modelRegistry: RouterModelRegistry;
  model:
    | {
        provider: string;
        id: string;
        contextWindow?: number;
        maxTokens?: number;
      }
    | undefined;
  sessionManager: {
    getBranch: () => readonly CustomSessionEntry[];
  };
  ui: RouterUIContext['ui'] &
    RouterCommandContext['ui'] & {
      setHiddenThinkingLabel?: (label?: string) => void;
    };
}

export interface RouterModelSelectEvent {
  model: {
    provider: string;
    id: string;
    contextWindow?: number;
    maxTokens?: number;
  };
}

export interface RouterThinkingLevelSelectEvent {
  level: ThinkingLevel;
}

export interface RouterExtensionAPI<
  TCtx extends RouterExtensionContext = ExtensionContext,
> {
  registerProvider: ExtensionAPI['registerProvider'];
  registerCommand: (
    name: string,
    options: {
      description?: string;
      getArgumentCompletions?: (argumentPrefix: string) =>
        | Array<{ value: string; label: string; description?: string }>
        | null
        | Promise<Array<{
            value: string;
            label: string;
            description?: string;
          }> | null>;
      handler: (args: string, ctx: TCtx) => Promise<void>;
    },
  ) => void;
  setModel: ExtensionAPI['setModel'];
  setThinkingLevel: ExtensionAPI['setThinkingLevel'];
  appendEntry: ExtensionAPI['appendEntry'];
  on(
    event: 'session_start' | 'turn_start' | 'turn_end',
    handler: (event: unknown, ctx: TCtx) => Promise<void> | void,
  ): void;
  on(
    event: 'model_select',
    handler: (event: RouterModelSelectEvent, ctx: TCtx) => Promise<void> | void,
  ): void;
  on(
    event: 'thinking_level_select',
    handler: (
      event: RouterThinkingLevelSelectEvent,
      ctx: TCtx,
    ) => Promise<void> | void,
  ): void;
}

export interface RoutingRule {
  matches: string | string[];
  tier: RouterTier;
  reason?: string;
}

export interface ModelDefinition {
  model: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevels?: ThinkingLevel[];
}

export interface ClassifierConfig {
  model: string;
  thinking?: ThinkingLevel;
}

export interface RoutedTierConfig {
  model: string;
  thinking?: ThinkingLevel;
  fallbacks?: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevels?: ThinkingLevel[];
  resolvedContextWindow?: number;
  resolvedMaxTokens?: number;
  resolvedThinkingLevels?: ThinkingLevel[];
}

export interface RouterProfile {
  high?: RoutedTierConfig;
  medium?: RoutedTierConfig;
  low?: RoutedTierConfig;
}

export interface RouterConfig {
  debug?: boolean;
  classifierModel?: ClassifierConfig;
  phaseBias?: number;
  maxSessionBudget?: number;
  rules?: RoutingRule[];
  profiles: Record<string, RouterProfile>;
  models?: Record<string, ModelDefinition>;
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
  isBudgetForced?: boolean;
  isRuleMatched?: boolean;
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
