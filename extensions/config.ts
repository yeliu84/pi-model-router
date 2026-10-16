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
  RouterModelCapabilityLookup,
} from './types';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './constants';

export const ROUTER_TIERS = ['high', 'medium', 'low'] as const;

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
export const ROUTER_PIN_VALUES = ['auto', 'high', 'medium', 'low'] as const;

export const DEFAULT_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'high',
  'medium',
  'low',
] as const;

export const isObjectRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === 'string' && THINKING_LEVELS.includes(value as ThinkingLevel);

export const isRouterTier = (value: unknown): value is RouterTier =>
  value === 'high' || value === 'medium' || value === 'low';

const parsePositiveNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && value > 0 ? value : undefined;

const parseThinkingLevels = (value: unknown): ThinkingLevel[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter(isThinkingLevel);
  return filtered.length > 0 ? filtered : undefined;
};

export const parseConfigFile = (path: string): ParsedConfigFile => {
  if (!existsSync(path)) {
    return { config: {}, warnings: [] };
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
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
      warnings.push(
        `Ignored invalid model definition "${alias}": expected an object.`,
      );
      continue;
    }

    const model = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (!model) {
      warnings.push(
        `Model definition "${alias}" is missing the "model" field. Skipped.`,
      );
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

    const contextWindow = parsePositiveNumber(entry.contextWindow);
    if (entry.contextWindow !== undefined && !contextWindow) {
      warnings.push(
        `Model definition "${alias}" has invalid contextWindow. Ignored.`,
      );
    }

    const maxTokens = parsePositiveNumber(entry.maxTokens);
    if (entry.maxTokens !== undefined && !maxTokens) {
      warnings.push(
        `Model definition "${alias}" has invalid maxTokens. Ignored.`,
      );
    }

    const reasoning =
      typeof entry.reasoning === 'boolean' ? entry.reasoning : undefined;

    const thinkingLevels = parseThinkingLevels(entry.thinkingLevels);

    result[alias] = {
      model,
      contextWindow,
      maxTokens,
      reasoning,
      thinkingLevels,
    };
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

  const thinking = isThinkingLevel(value.thinking) ? value.thinking : 'medium';
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
  const tierContextWindow = parsePositiveNumber(value.contextWindow);
  const resolvedContextWindow =
    tierContextWindow ??
    aliasDefinition?.contextWindow ??
    DEFAULT_CONTEXT_WINDOW;

  // Resolve maxTokens: tier config > alias > hardcoded default
  const tierMaxTokens = parsePositiveNumber(value.maxTokens);
  const resolvedMaxTokens =
    tierMaxTokens ?? aliasDefinition?.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Resolve reasoning: tier config > alias > undefined (assumed true)
  const tierReasoning =
    typeof value.reasoning === 'boolean' ? value.reasoning : undefined;
  const effectiveReasoning = tierReasoning ?? aliasDefinition?.reasoning;

  // Resolve thinkingLevels: tier config > alias > default
  const tierThinkingLevels = parseThinkingLevels(value.thinkingLevels);

  const explicitThinkingLevels =
    tierThinkingLevels ?? aliasDefinition?.thinkingLevels;
  const baseThinkingLevels: ThinkingLevel[] =
    explicitThinkingLevels ??
    (effectiveReasoning === false ? [] : [...DEFAULT_THINKING_LEVELS]);

  // Auto-add the tier's thinking value if it's not 'off' and not already present,
  // but only if the user didn't explicitly constrain the thinkingLevels array.
  const resolvedThinkingLevels: ThinkingLevel[] = [...baseThinkingLevels];
  if (
    !explicitThinkingLevels &&
    thinking !== 'off' &&
    !resolvedThinkingLevels.includes(thinking)
  ) {
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

export const normalizeConfig = (
  raw: RouterConfig | Record<string, unknown>,
): ConfigLoadResult => {
  const warnings: string[] = [];

  // Normalize models map first so aliases are available during tier normalization
  const rawModels = isObjectRecord(raw.models) ? raw.models : undefined;
  const normalizedModels = normalizeModelsMap(rawModels, warnings);
  const hasModels = Object.keys(normalizedModels).length > 0;

  const normalizedProfiles: Record<string, RouterProfile> = {};
  const rawProfiles = isObjectRecord(raw.profiles) ? raw.profiles : {};

  for (const [name, profile] of Object.entries(rawProfiles)) {
    const profileObj = isObjectRecord(profile) ? profile : undefined;
    const high = normalizeTierConfig(
      profileObj?.high,
      name,
      'high',
      warnings,
      hasModels ? normalizedModels : undefined,
    );
    const medium = normalizeTierConfig(
      profileObj?.medium,
      name,
      'medium',
      warnings,
      hasModels ? normalizedModels : undefined,
    );
    const low = normalizeTierConfig(
      profileObj?.low,
      name,
      'low',
      warnings,
      hasModels ? normalizedModels : undefined,
    );

    if (!high && !medium && !low) {
      warnings.push(`Profile "${name}" has no valid tiers. Skipped.`);
      continue;
    }

    normalizedProfiles[name] = { high, medium, low };
  }

  const phaseBias =
    typeof raw.phaseBias === 'number'
      ? Math.max(0, Math.min(1, raw.phaseBias))
      : 0.5;

  const maxSessionBudget = parsePositiveNumber(raw.maxSessionBudget);

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

  // Resolve classifierModel — accepts string ("auto", alias, or "provider/model") or { model, thinking } object
  const resolveClassifierRef = (
    modelRef: string,
    thinking?: ThinkingLevel,
  ): ClassifierConfig | undefined => {
    if (modelRef === 'auto') {
      return { model: 'auto', ...(thinking ? { thinking } : {}) };
    }
    const resolved = resolveModelRef(
      modelRef,
      hasModels ? normalizedModels : undefined,
    );
    try {
      parseCanonicalModelRef(resolved.canonicalRef);
      return {
        model: resolved.canonicalRef,
        ...(thinking ? { thinking } : {}),
      };
    } catch (error) {
      warnings.push(
        `Invalid classifierModel: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };

  let classifierModel: ClassifierConfig | undefined;
  const rawClassifier: unknown = raw.classifierModel;
  if (typeof rawClassifier === 'string' && rawClassifier.trim()) {
    classifierModel = resolveClassifierRef(rawClassifier.trim());
  } else if (isObjectRecord(rawClassifier)) {
    const modelRef =
      typeof rawClassifier.model === 'string' ? rawClassifier.model.trim() : '';
    if (modelRef) {
      const thinking = isThinkingLevel(rawClassifier.thinking)
        ? rawClassifier.thinking
        : undefined;
      if (rawClassifier.thinking !== undefined && !thinking) {
        warnings.push(
          `classifierModel has invalid thinking level "${String(rawClassifier.thinking)}". Ignored.`,
        );
      }
      classifierModel = resolveClassifierRef(modelRef, thinking);
    } else {
      warnings.push(
        'classifierModel object is missing the "model" field. Ignored.',
      );
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

const findTierModel = (
  tierConfig: RoutedTierConfig | undefined,
  modelRegistry?: RouterModelCapabilityLookup,
) => {
  if (!tierConfig || !modelRegistry) return undefined;
  try {
    const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
    return modelRegistry.find(provider, modelId);
  } catch {
    return undefined;
  }
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
  modelRegistry: RouterModelCapabilityLookup | undefined,
): number => {
  const tierConfig = profile[tier];
  return (
    findTierModel(tierConfig, modelRegistry)?.contextWindow ||
    tierConfig?.resolvedContextWindow ||
    DEFAULT_CONTEXT_WINDOW
  );
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
  modelRegistry: RouterModelCapabilityLookup | undefined,
): number => {
  const tierConfig = profile[tier];
  return (
    findTierModel(tierConfig, modelRegistry)?.maxTokens ||
    tierConfig?.resolvedMaxTokens ||
    DEFAULT_MAX_TOKENS
  );
};

/**
 * Resolve the effective supported thinking levels for a specific tier at runtime,
 * incorporating the API model registry's thinkingLevelMap when available.
 *
 * Resolution chain: API (thinkingLevelMap / reasoning=false) > tier config > model alias > default
 */
export const resolveThinkingLevels = (
  tier: RouterTier,
  profile: RouterProfile,
  modelRegistry?: RouterModelCapabilityLookup,
  targetModel?: {
    reasoning?: boolean;
    thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  },
): ThinkingLevel[] | undefined => {
  const tierConfig = profile[tier];
  const registryModel =
    (targetModel?.thinkingLevelMap || targetModel?.reasoning === false
      ? targetModel
      : undefined) ?? findTierModel(tierConfig, modelRegistry);
  if (registryModel?.reasoning === false) return [];
  const map = registryModel?.thinkingLevelMap;
  if (map) {
    return THINKING_LEVELS.filter(
      (l) =>
        l !== 'off' &&
        (l === 'xhigh' || l === 'max' ? map[l] != null : map[l] !== null),
    );
  }
  return tierConfig?.resolvedThinkingLevels;
};

/**
 * Collect the union of all tier models' resolved thinking levels for a profile.
 * Returns a Set of ThinkingLevel values.
 */
export const collectProfileThinkingLevels = (
  profile: RouterProfile,
  modelRegistry?: RouterModelCapabilityLookup,
): Set<ThinkingLevel> =>
  new Set(
    ROUTER_TIERS.flatMap(
      (tier) => resolveThinkingLevels(tier, profile, modelRegistry) ?? [],
    ),
  );

/**
 * Returns tier names whose models don't include the given thinking level
 * in their resolved thinking levels (or explicitly disallow 'off' via thinkingLevelMap).
 */
export const getUnsupportedTiers = (
  profile: RouterProfile,
  level: ThinkingLevel,
  modelRegistry?: RouterModelCapabilityLookup,
): string[] =>
  ROUTER_TIERS.filter((tier) => {
    const tierConfig = profile[tier];
    if (!tierConfig) return false;
    if (level === 'off') {
      const registryModel = findTierModel(tierConfig, modelRegistry);
      return (
        registryModel?.reasoning !== false &&
        registryModel?.thinkingLevelMap?.off === null
      );
    }
    return !resolveThinkingLevels(tier, profile, modelRegistry)?.includes(
      level,
    );
  });

/**
 * Clamps a requested thinking level to the nearest supported level
 * in the provided array of supported levels. Searches downwards first,
 * then upwards if the model only supports higher levels (e.g. Xiaomi MiMo
 * 'high'-only or Claude 5.5 / GPT-6 without 'minimal' or 'off').
 */
export const clampThinkingLevel = (
  requested: ThinkingLevel,
  supported: ThinkingLevel[] | undefined,
  allowOff = true,
): ThinkingLevel => {
  if (!supported) return requested;
  if (requested === 'off') {
    return allowOff
      ? 'off'
      : (THINKING_LEVELS.find((l) => l !== 'off' && supported.includes(l)) ??
          'off');
  }

  const reqIdx = THINKING_LEVELS.indexOf(requested);
  for (let i = reqIdx; i >= 0; i--) {
    if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }
  for (let i = reqIdx + 1; i < THINKING_LEVELS.length; i++) {
    if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }

  return 'off';
};
