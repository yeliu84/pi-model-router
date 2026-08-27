import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  RouterConfig,
  RouterProfile,
  RoutedTierConfig,
  ConfigLoadResult,
  ParsedConfigFile,
  RouterTier,
  RoutingRule,
  ModelDefinition,
  ClassifierConfig,
} from './types';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from './constants';

export const ROUTER_TIERS = ['high', 'medium', 'low'] as const;

// Pi accepts this model capability at runtime, but older peer type releases omit it.
export const MAX_THINKING_LEVEL = 'max' as ThinkingLevel;

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  MAX_THINKING_LEVEL,
];
export const ROUTER_PIN_VALUES = ['auto', 'high', 'medium', 'low'] as const;

export const DEFAULT_THINKING_LEVELS: readonly ThinkingLevel[] = ['high', 'medium', 'low'] as const;

export const isObjectRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === 'string' && THINKING_LEVELS.includes(value as ThinkingLevel);

export const isRouterTier = (value: unknown): value is RouterTier =>
  value === 'high' || value === 'medium' || value === 'low';

export const parseConfigFile = (path: string): ParsedConfigFile => {
  if (!existsSync(path)) {
    return { config: {}, warnings: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isObjectRecord(parsed)) {
      return {
        config: {},
        warnings: [`Ignored router config at ${path}: expected a JSON object.`],
      };
    }
    return { config: parsed as Partial<RouterConfig>, warnings: [] };
  } catch (error) {
    return {
      config: {},
      warnings: [
        `Failed to parse router config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
};

/**
 * Resolve a model reference: if it matches a key in the models map,
 * return the canonical ref and definition; otherwise treat it as a
 * canonical "provider/model" ref.
 */
export const resolveModelRef = (
  ref: string,
  models: Record<string, ModelDefinition> | undefined,
): { canonicalRef: string; definition?: ModelDefinition } => {
  const definition = models?.[ref];
  if (definition) {
    return { canonicalRef: definition.model, definition };
  }
  return { canonicalRef: ref };
};

const mergeTier = (
  existing?: RoutedTierConfig,
  next?: Partial<RoutedTierConfig>,
): RoutedTierConfig | undefined => {
  if (!existing && !next) return undefined;
  if (!next) return existing;
  if (!existing) return next as RoutedTierConfig;
  return { ...existing, ...next };
};

export const mergeConfig = (
  base: RouterConfig,
  override: Partial<RouterConfig>,
): RouterConfig => {
  const mergedProfiles: Record<string, RouterProfile> = { ...base.profiles };
  for (const [name, profile] of Object.entries(override.profiles ?? {})) {
    const existing = mergedProfiles[name];
    const nextProfile = profile as Partial<RouterProfile>;
    mergedProfiles[name] = {
      high: mergeTier(existing?.high, nextProfile.high),
      medium: mergeTier(existing?.medium, nextProfile.medium),
      low: mergeTier(existing?.low, nextProfile.low),
    };
  }

  const mergedModels: Record<string, ModelDefinition> = {
    ...(base.models ?? {}),
    ...(override.models ?? {}),
  };

  return {
    debug: override.debug ?? base.debug,
    classifierModel: override.classifierModel ?? base.classifierModel,
    phaseBias: override.phaseBias ?? base.phaseBias,
    maxSessionBudget: override.maxSessionBudget ?? base.maxSessionBudget,
    rules: override.rules ?? base.rules,
    profiles: mergedProfiles,
    models: Object.keys(mergedModels).length > 0 ? mergedModels : undefined,
  };
};

export const parseCanonicalModelRef = (
  value: string,
): { provider: string; modelId: string } => {
  const slashIndex = value.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(
      `Invalid model reference "${value}". Expected "provider/model".`,
    );
  }
  const provider = value.slice(0, slashIndex).trim();
  const modelId = value.slice(slashIndex + 1).trim();
  if (!provider || !modelId) {
    throw new Error(
      `Invalid model reference "${value}". Expected "provider/model".`,
    );
  }
  return { provider, modelId };
};

/**
 * Validate and normalize the models map from config.
 */
export const normalizeModelsMap = (
  raw: Record<string, unknown> | undefined,
  warnings: string[],
): Record<string, ModelDefinition> => {
  const result: Record<string, ModelDefinition> = {};
  if (!raw || !isObjectRecord(raw)) return result;

  for (const [alias, entry] of Object.entries(raw)) {
    if (!isObjectRecord(entry)) {
      warnings.push(`Ignored invalid model definition "${alias}": expected an object.`);
      continue;
    }

    const model = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (!model) {
      warnings.push(`Model definition "${alias}" is missing the "model" field. Skipped.`);
      continue;
    }

    try {
      parseCanonicalModelRef(model);
    } catch (error) {
      warnings.push(
        `Model definition "${alias}": ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const contextWindow =
      typeof entry.contextWindow === 'number' && entry.contextWindow > 0
        ? entry.contextWindow
        : undefined;
    if (entry.contextWindow !== undefined && !contextWindow) {
      warnings.push(
        `Model definition "${alias}" has invalid contextWindow. Ignored.`,
      );
    }

    const maxTokens =
      typeof entry.maxTokens === 'number' && entry.maxTokens > 0
        ? entry.maxTokens
        : undefined;
    if (entry.maxTokens !== undefined && !maxTokens) {
      warnings.push(
        `Model definition "${alias}" has invalid maxTokens. Ignored.`,
      );
    }

    const reasoning =
      typeof entry.reasoning === 'boolean' ? entry.reasoning : undefined;

    let thinkingLevels: ThinkingLevel[] | undefined;
    if (Array.isArray(entry.thinkingLevels)) {
      thinkingLevels = entry.thinkingLevels.filter(
        (l): l is ThinkingLevel => isThinkingLevel(l),
      );
      if (thinkingLevels.length === 0) thinkingLevels = undefined;
    }

    result[alias] = { model, contextWindow, maxTokens, reasoning, thinkingLevels };
  }

  return result;
};

export const normalizeTierConfig = (
  value: unknown,
  profileName: string,
  tier: RouterTier,
  warnings: string[],
  models?: Record<string, ModelDefinition>,
): RoutedTierConfig | undefined => {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  const rawModel = typeof value.model === 'string' ? value.model.trim() : '';
  let aliasDefinition: ModelDefinition | undefined;

  if (!rawModel) {
    warnings.push(
      `Profile "${profileName}" ${tier} tier is missing a model. Tier disabled.`,
    );
    return undefined;
  }

  // Try to resolve as an alias first
  const resolved = resolveModelRef(rawModel, models);
  aliasDefinition = resolved.definition;
  let parsedModel: string;
  try {
    parseCanonicalModelRef(resolved.canonicalRef);
    parsedModel = resolved.canonicalRef;
  } catch (error) {
    warnings.push(
      `Profile "${profileName}" ${tier} tier: ${error instanceof Error ? error.message : String(error)} Tier disabled.`,
    );
    return undefined;
  }

  const thinking = isThinkingLevel(value.thinking)
    ? value.thinking
    : 'medium';
  if (value.thinking !== undefined && !isThinkingLevel(value.thinking)) {
    warnings.push(
      `Profile "${profileName}" ${tier} tier has invalid thinking level. Defaulting to medium.`,
    );
  }

  let fallbacks: string[] | undefined = undefined;
  if (Array.isArray(value.fallbacks)) {
    fallbacks = [];
    for (const f of value.fallbacks) {
      if (typeof f === 'string') {
        // Resolve aliases in fallbacks too
        const resolvedFallback = resolveModelRef(f, models);
        try {
          parseCanonicalModelRef(resolvedFallback.canonicalRef);
          fallbacks.push(resolvedFallback.canonicalRef);
        } catch (error) {
          warnings.push(
            `Invalid fallback model "${f}" in profile "${profileName}" ${tier} tier: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  // Resolve contextWindow: tier config > alias > hardcoded default
  const tierContextWindow =
    typeof value.contextWindow === 'number' && value.contextWindow > 0
      ? value.contextWindow
      : undefined;
  const resolvedContextWindow =
    tierContextWindow ?? aliasDefinition?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

  // Resolve maxTokens: tier config > alias > hardcoded default
  const tierMaxTokens =
    typeof value.maxTokens === 'number' && value.maxTokens > 0
      ? value.maxTokens
      : undefined;
  const resolvedMaxTokens =
    tierMaxTokens ?? aliasDefinition?.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Resolve reasoning: tier config > alias > undefined (assumed true)
  const tierReasoning =
    typeof value.reasoning === 'boolean' ? value.reasoning : undefined;
  const effectiveReasoning = tierReasoning ?? aliasDefinition?.reasoning;

  // Resolve thinkingLevels: tier config > alias > default
  // Validate tier-level thinkingLevels array
  let tierThinkingLevels: ThinkingLevel[] | undefined;
  if (Array.isArray(value.thinkingLevels)) {
    tierThinkingLevels = (value.thinkingLevels as unknown[]).filter(
      (l): l is ThinkingLevel => isThinkingLevel(l),
    );
    if (tierThinkingLevels.length === 0) tierThinkingLevels = undefined;
  }

  const explicitThinkingLevels = tierThinkingLevels ?? aliasDefinition?.thinkingLevels;
  const baseThinkingLevels: ThinkingLevel[] =
    explicitThinkingLevels ??
    (effectiveReasoning === false ? [] : [...DEFAULT_THINKING_LEVELS]);

  // Auto-add the tier's thinking value if it's not 'off' and not already present,
  // but only if the user didn't explicitly constrain the thinkingLevels array.
  const resolvedThinkingLevels: ThinkingLevel[] = [...baseThinkingLevels];
  if (!explicitThinkingLevels && thinking !== 'off' && !resolvedThinkingLevels.includes(thinking)) {
    resolvedThinkingLevels.push(thinking);
  }

  return {
    model: parsedModel,
    thinking,
    fallbacks,
    contextWindow: tierContextWindow,
    maxTokens: tierMaxTokens,
    reasoning: tierReasoning,
    thinkingLevels: tierThinkingLevels,
    resolvedContextWindow,
    resolvedMaxTokens,
    resolvedThinkingLevels,
  };
};

export const normalizeConfig = (raw: RouterConfig): ConfigLoadResult => {
  const warnings: string[] = [];

  // Normalize models map first so aliases are available during tier normalization
  const normalizedModels = normalizeModelsMap(
    raw.models as Record<string, unknown> | undefined,
    warnings,
  );
  const hasModels = Object.keys(normalizedModels).length > 0;

  const normalizedProfiles: Record<string, RouterProfile> = {};

  for (const [name, profile] of Object.entries(raw.profiles ?? {})) {
    const high = normalizeTierConfig(
      profile?.high,
      name,
      'high',
      warnings,
      hasModels ? normalizedModels : undefined,
    );
    const medium = normalizeTierConfig(
      profile?.medium,
      name,
      'medium',
      warnings,
      hasModels ? normalizedModels : undefined,
    );
    const low = normalizeTierConfig(
      profile?.low,
      name,
      'low',
      warnings,
      hasModels ? normalizedModels : undefined,
    );

    if (!high && !medium && !low) {
      warnings.push(
        `Profile "${name}" has no valid tiers. Skipped.`,
      );
      continue;
    }

    normalizedProfiles[name] = { high, medium, low };
  }

  const phaseBias =
    typeof raw.phaseBias === 'number'
      ? Math.max(0, Math.min(1, raw.phaseBias))
      : 0.5;

  const maxSessionBudget =
    typeof raw.maxSessionBudget === 'number' && raw.maxSessionBudget > 0
      ? raw.maxSessionBudget
      : undefined;

  const rules: RoutingRule[] = [];
  if (Array.isArray(raw.rules)) {
    for (const rule of raw.rules) {
      if (isObjectRecord(rule)) {
        const matches = rule.matches;
        const tier = rule.tier;
        if (
          (typeof matches === 'string' || Array.isArray(matches)) &&
          isRouterTier(tier)
        ) {
          rules.push({
            matches,
            tier,
            reason: typeof rule.reason === 'string' ? rule.reason : undefined,
          });
        } else {
          warnings.push(
            `Ignored invalid routing rule: ${JSON.stringify(rule)}`,
          );
        }
      }
    }
  }

  // Resolve classifierModel — accepts string or { model, thinking } object
  let classifierModel: ClassifierConfig | undefined;
  const rawClassifier = raw.classifierModel as unknown;
  if (typeof rawClassifier === 'string' && rawClassifier.trim()) {
    const resolved = resolveModelRef(
      rawClassifier.trim(),
      hasModels ? normalizedModels : undefined,
    );
    try {
      parseCanonicalModelRef(resolved.canonicalRef);
      classifierModel = { model: resolved.canonicalRef };
    } catch (error) {
      warnings.push(
        `Invalid classifierModel: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (isObjectRecord(rawClassifier)) {
    const modelRef = typeof rawClassifier.model === 'string' ? rawClassifier.model.trim() : '';
    if (modelRef) {
      const resolved = resolveModelRef(
        modelRef,
        hasModels ? normalizedModels : undefined,
      );
      try {
        parseCanonicalModelRef(resolved.canonicalRef);
        const thinking = isThinkingLevel(rawClassifier.thinking)
          ? rawClassifier.thinking
          : undefined;
        if (rawClassifier.thinking !== undefined && !thinking) {
          warnings.push(
            `classifierModel has invalid thinking level "${String(rawClassifier.thinking)}". Ignored.`,
          );
        }
        classifierModel = { model: resolved.canonicalRef, thinking };
      } catch (error) {
        warnings.push(
          `Invalid classifierModel: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      warnings.push('classifierModel object is missing the "model" field. Ignored.');
    }
  }

  return {
    config: {
      debug: typeof raw.debug === 'boolean' ? raw.debug : false,
      classifierModel,
      phaseBias,
      maxSessionBudget,
      rules: rules.length > 0 ? rules : undefined,
      profiles: normalizedProfiles,
      models: hasModels ? normalizedModels : undefined,
    },
    warnings,
  };
};

export const loadRouterConfig = (cwd: string): ConfigLoadResult => {
  const globalPath = join(getAgentDir(), 'model-router.json');
  const projectPath = join(cwd, '.pi', 'model-router.json');
  const globalResult = parseConfigFile(globalPath);
  const projectResult = parseConfigFile(projectPath);
  const baseConfig: RouterConfig = { profiles: {} };
  const merged = mergeConfig(
    mergeConfig(baseConfig, globalResult.config),
    projectResult.config,
  );
  const normalized = normalizeConfig(merged);
  return {
    config: normalized.config,
    warnings: [
      ...globalResult.warnings,
      ...projectResult.warnings,
      ...normalized.warnings,
    ],
  };
};

export const profileNames = (config: RouterConfig): string[] => {
  return Object.keys(config.profiles).sort();
};

export const resolveProfileName = (
  config: RouterConfig,
  requested?: string,
): string | undefined => {
  if (requested && config.profiles[requested]) {
    return requested;
  }
  return undefined;
};

/**
 * Resolve the effective context window for a specific tier at runtime,
 * incorporating the API model registry as the highest-priority source.
 *
 * Resolution chain: API > tier config > model alias > hardcoded default
 */
export const resolveContextWindow = (
  tier: RouterTier,
  profile: RouterProfile,
  modelRegistry: ExtensionContext['modelRegistry'] | undefined,
): number => {
  const tierConfig = profile[tier];
  if (!tierConfig) return DEFAULT_CONTEXT_WINDOW;

  // 1. API value (highest priority)
  if (modelRegistry) {
    try {
      const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
      const registryModel = modelRegistry.find(provider, modelId);
      if (registryModel?.contextWindow) return registryModel.contextWindow;
    } catch { /* ignore */ }
  }

  // 2-4. Pre-resolved during config normalization (tier > alias > hardcoded)
  return tierConfig.resolvedContextWindow ?? DEFAULT_CONTEXT_WINDOW;
};

/**
 * Resolve the effective max tokens for a specific tier at runtime,
 * incorporating the API model registry as the highest-priority source.
 *
 * Resolution chain: API > tier config > model alias > hardcoded default
 */
export const resolveMaxTokens = (
  tier: RouterTier,
  profile: RouterProfile,
  modelRegistry: ExtensionContext['modelRegistry'] | undefined,
): number => {
  const tierConfig = profile[tier];
  if (!tierConfig) return DEFAULT_MAX_TOKENS;

  // 1. API value (highest priority)
  if (modelRegistry) {
    try {
      const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
      const registryModel = modelRegistry.find(provider, modelId);
      if (registryModel?.maxTokens) return registryModel.maxTokens;
    } catch { /* ignore */ }
  }

  // 2-4. Pre-resolved during config normalization (tier > alias > hardcoded)
  return tierConfig.resolvedMaxTokens ?? DEFAULT_MAX_TOKENS;
};

/**
 * Collect the union of all tier models' resolved thinking levels for a profile.
 * Returns a Set of ThinkingLevel values.
 */
export const collectProfileThinkingLevels = (
  profile: RouterProfile,
): Set<ThinkingLevel> => {
  const levels = new Set<ThinkingLevel>();
  for (const tier of ROUTER_TIERS) {
    const tierConfig = profile[tier];
    if (!tierConfig?.resolvedThinkingLevels) continue;
    for (const level of tierConfig.resolvedThinkingLevels) {
      levels.add(level);
    }
  }
  return levels;
};

/**
 * Returns tier names whose models don't include the given thinking level
 * in their resolvedThinkingLevels.
 */
export const getUnsupportedTiers = (
  profile: RouterProfile,
  level: ThinkingLevel,
): string[] => {
  const unsupported: string[] = [];
  for (const tier of ROUTER_TIERS) {
    const tierConfig = profile[tier];
    if (!tierConfig) continue;
    if (!tierConfig.resolvedThinkingLevels?.includes(level)) {
      unsupported.push(tier);
    }
  }
  return unsupported;
};

/**
 * Clamps a requested thinking level to the highest supported level
 * in the provided array of supported levels.
 */
export const clampThinkingLevel = (
  requested: ThinkingLevel,
  supported: ThinkingLevel[] | undefined,
): ThinkingLevel => {
  if (requested === 'off' || !supported || supported.length === 0) {
    return 'off';
  }
  
  const reqIdx = THINKING_LEVELS.indexOf(requested);
  for (let i = reqIdx; i >= 0; i--) {
    if (supported.includes(THINKING_LEVELS[i])) {
      return THINKING_LEVELS[i];
    }
  }
  
  return 'off';
};
