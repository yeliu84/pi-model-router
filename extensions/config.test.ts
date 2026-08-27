import { describe, it, expect, vi } from 'vitest';
import {
  parseConfigFile,
  resolveModelRef,
  mergeConfig,
  parseCanonicalModelRef,
  normalizeModelsMap,
  normalizeTierConfig,
  normalizeConfig,
  loadRouterConfig,
  profileNames,
  resolveProfileName,
  resolveContextWindow,
  resolveMaxTokens,
  collectProfileThinkingLevels,
  getUnsupportedTiers,
  isObjectRecord,
  isThinkingLevel,
  isRouterTier,
} from './config';
import type { RouterConfig, RouterProfile, ModelDefinition, RoutedTierConfig } from './types';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/mock/agent/dir',
}));

vi.mock('node:fs', () => ({
  existsSync: (path: string) =>
    path.includes('exists') || path.includes('model-router.json'),
  readFileSync: (path: string) => {
    if (path.includes('invalid-json')) {
      return '{invalid';
    }
    if (path.includes('not-object')) {
      return '123';
    }
    if (
      path.includes('global') ||
      (path.endsWith('model-router.json') && !path.includes('.pi'))
    ) {
      return JSON.stringify({
        debug: true,
        profiles: {
          globalProfile: {
            medium: { model: 'openai/gpt-4o' },
          },
        },
      });
    }
    if (
      path.includes('project') ||
      path.includes('.pi/model-router.json') ||
      path.includes('.pi\\model-router.json')
    ) {
      return JSON.stringify({
        profiles: {
          projectProfile: {
            high: { model: 'google/gemini-1.5-pro' },
          },
        },
      });
    }
    return '{}';
  },
}));

describe('config.ts', () => {
  describe('type guards', () => {
    it('isObjectRecord should validate objects', () => {
      expect(isObjectRecord({})).toBe(true);
      expect(isObjectRecord({ a: 1 })).toBe(true);
      expect(isObjectRecord(null)).toBe(false);
      expect(isObjectRecord('string')).toBe(false);
      expect(isObjectRecord([])).toBe(false);
    });

    it('isThinkingLevel should validate thinking levels', () => {
      expect(isThinkingLevel('off')).toBe(true);
      expect(isThinkingLevel('high')).toBe(true);
      expect(isThinkingLevel('xhigh')).toBe(true);
      expect(isThinkingLevel('max')).toBe(true);
      expect(isThinkingLevel('invalid')).toBe(false);
      expect(isThinkingLevel(123)).toBe(false);
    });

    it('isRouterTier should validate tiers', () => {
      expect(isRouterTier('high')).toBe(true);
      expect(isRouterTier('medium')).toBe(true);
      expect(isRouterTier('low')).toBe(true);
      expect(isRouterTier('auto')).toBe(false);
      expect(isRouterTier('invalid')).toBe(false);
    });
  });

  describe('parseConfigFile', () => {
    it('should return empty config and no warnings for non-existent file', () => {
      const result = parseConfigFile('/path/does-not-exist');
      expect(result.config).toEqual({});
      expect(result.warnings).toEqual([]);
    });

    it('should return warnings on json syntax errors', () => {
      const result = parseConfigFile('/path/exists-invalid-json');
      expect(result.config).toEqual({});
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Failed to parse router config');
    });

    it('should return warnings if root is not an object', () => {
      const result = parseConfigFile('/path/exists-not-object');
      expect(result.config).toEqual({});
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('expected a JSON object');
    });

    it('should parse valid json object', () => {
      const result = parseConfigFile('/path/exists-global');
      expect(result.config).toHaveProperty('debug', true);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('resolveModelRef', () => {
    const models: Record<string, ModelDefinition> = {
      gpt4: { model: 'openai/gpt-4o', contextWindow: 128000 },
    };

    it('should resolve defined alias', () => {
      const resolved = resolveModelRef('gpt4', models);
      expect(resolved.canonicalRef).toBe('openai/gpt-4o');
      expect(resolved.definition).toBe(models.gpt4);
    });

    it('should return canonical ref if not an alias', () => {
      const resolved = resolveModelRef('anthropic/claude-3-opus', models);
      expect(resolved.canonicalRef).toBe('anthropic/claude-3-opus');
      expect(resolved.definition).toBeUndefined();
    });
  });

  describe('mergeConfig', () => {
    it('should merge profiles and models override', () => {
      const base: RouterConfig = {
        debug: false,
        profiles: {
          balanced: {
            medium: { model: 'openai/gpt-4o-mini' },
          },
        },
        models: {
          gpt4: { model: 'openai/gpt-4o' },
        },
      };

      const override: Partial<RouterConfig> = {
        debug: true,
        profiles: {
          balanced: {
            high: { model: 'openai/gpt-4o' },
          },
          cheap: {
            low: { model: 'openai/gpt-4o-mini' },
          },
        },
        models: {
          claude: { model: 'anthropic/claude-3.5-sonnet' },
        },
      };

      const merged = mergeConfig(base, override);
      expect(merged.debug).toBe(true);
      expect(merged.profiles.balanced.medium?.model).toBe('openai/gpt-4o-mini');
      expect(merged.profiles.balanced.high?.model).toBe('openai/gpt-4o');
      expect(merged.profiles.cheap?.low?.model).toBe('openai/gpt-4o-mini');
      expect(merged.models?.gpt4.model).toBe('openai/gpt-4o');
      expect(merged.models?.claude.model).toBe('anthropic/claude-3.5-sonnet');
    });
  });

  describe('parseCanonicalModelRef', () => {
    it('should parse correct references', () => {
      const parsed = parseCanonicalModelRef('openai/gpt-4o');
      expect(parsed).toEqual({ provider: 'openai', modelId: 'gpt-4o' });
    });

    it('should throw on missing slash', () => {
      expect(() => parseCanonicalModelRef('gpt-4o')).toThrow(
        'Invalid model reference',
      );
    });

    it('should throw on empty provider or modelId', () => {
      expect(() => parseCanonicalModelRef('/gpt-4o')).toThrow(
        'Invalid model reference',
      );
      expect(() => parseCanonicalModelRef('openai/')).toThrow(
        'Invalid model reference',
      );
      expect(() => parseCanonicalModelRef('   /gpt-4o')).toThrow(
        'Invalid model reference',
      );
    });
  });

  describe('normalizeModelsMap', () => {
    it('should extract valid models and log warnings', () => {
      const warnings: string[] = [];
      const raw = {
        valid: { model: 'openai/gpt-4o', contextWindow: 100000 },
        invalidType: 'not-an-object',
        missingModel: { contextWindow: 100 },
        invalidRef: { model: 'gpt4' },
      };
      const result = normalizeModelsMap(
        raw as unknown as Record<string, unknown>,
        warnings,
      );
      expect(result.valid).toEqual({
        model: 'openai/gpt-4o',
        contextWindow: 100000,
        maxTokens: undefined,
      });
      expect(warnings.length).toBe(3);
    });
  });

  describe('normalizeTierConfig', () => {
    const models = {
      gpt4: { model: 'openai/gpt-4o', contextWindow: 80000 },
    };

    it('should return undefined if input is not object', () => {
      const warnings: string[] = [];
      expect(
        normalizeTierConfig('string', 'p', 'high', warnings),
      ).toBeUndefined();
    });

    it('should return undefined and warning if missing model', () => {
      const warnings: string[] = [];
      const result = normalizeTierConfig({}, 'p', 'high', warnings);
      expect(result).toBeUndefined();
      expect(warnings[0]).toContain('missing a model');
    });

    it('should resolve and normalize details', () => {
      const warnings: string[] = [];
      const raw = {
        model: 'gpt4',
        thinking: 'high',
        fallbacks: ['google/gemini-1.5-flash', 'invalid-fallback'],
        contextWindow: 50000,
        maxTokens: 2000,
      };
      const result = normalizeTierConfig(raw, 'p', 'high', warnings, models);
      expect(result).toBeDefined();
      expect(result?.model).toBe('openai/gpt-4o');
      expect(result?.thinking).toBe('high');
      expect(result?.fallbacks).toEqual(['google/gemini-1.5-flash']);
      expect(result?.resolvedContextWindow).toBe(50000);
      expect(result?.resolvedMaxTokens).toBe(2000);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('Invalid fallback model');
    });
  });

  describe('normalizeConfig', () => {
    it('should normalize rules, profiles, phaseBias, budget, classifierModel', () => {
      const raw = {
        debug: true,
        phaseBias: 0.8,
        maxSessionBudget: 5.5,
        classifierModel: 'gpt4',
        rules: [
          { matches: 'test', tier: 'high', reason: 'Rule reason' },
          { matches: ['foo', 'bar'], tier: 'low' },
        ],
        profiles: {
          balanced: {
            high: { model: 'google/gemini-2.5-pro' },
          },
        },
        models: {
          gpt4: { model: 'openai/gpt-4o' },
        },
      };

      const { config, warnings } = normalizeConfig(
        raw as unknown as RouterConfig,
      );
      expect(warnings).toEqual([]);
      expect(config.debug).toBe(true);
      expect(config.phaseBias).toBe(0.8);
      expect(config.maxSessionBudget).toBe(5.5);
      expect(config.classifierModel?.model).toBe('openai/gpt-4o');
      expect(config.rules?.length).toBe(2);
      expect(config.profiles.balanced?.high?.model).toBe(
        'google/gemini-2.5-pro',
      );
    });
  });

  describe('loadRouterConfig', () => {
    it('should merge and normalize global and project config files', () => {
      const { config } = loadRouterConfig('/path/exists');
      expect(config.debug).toBe(true);
      expect(config.profiles.globalProfile?.medium?.model).toBe(
        'openai/gpt-4o',
      );
      expect(config.profiles.projectProfile?.high?.model).toBe(
        'google/gemini-1.5-pro',
      );
    });
  });

  describe('profileNames', () => {
    it('should return sorted profile names', () => {
      const config: RouterConfig = {
        profiles: {
          zebra: {},
          apple: {},
          banana: {},
        },
      };
      expect(profileNames(config)).toEqual(['apple', 'banana', 'zebra']);
    });
  });

  describe('resolveProfileName', () => {
    const config: RouterConfig = {
      profiles: {
        balanced: {},
        cheap: {},
      },
    };

    it('should return requested if valid', () => {
      expect(resolveProfileName(config, 'balanced')).toBe('balanced');
    });

    it('should return undefined if invalid or missing', () => {
      expect(resolveProfileName(config, 'unknown')).toBeUndefined();
      expect(resolveProfileName(config)).toBeUndefined();
    });
  });

  describe('resolveContextWindow and resolveMaxTokens', () => {
    const profile: RouterProfile = {
      high: {
        model: 'openai/gpt-4o',
        resolvedContextWindow: 60000,
        resolvedMaxTokens: 4000,
      },
    };

    const mockRegistry = {
      find: (provider: string, modelId: string) => {
        if (provider === 'openai' && modelId === 'gpt-4o') {
          return { contextWindow: 99999, maxTokens: 8888 } as any;
        }
        return undefined;
      },
      getApiKeyAndHeaders: async () => ({
        ok: false as const,
        error: 'not-mocked',
      }),
    };

    it('should resolve using registry if available', () => {
      const cw = resolveContextWindow('high', profile, mockRegistry as any);
      const mot = resolveMaxTokens('high', profile, mockRegistry as any);
      expect(cw).toBe(99999);
      expect(mot).toBe(8888);
    });

    it('should fall back to pre-resolved config values if registry lookup fails or is missing', () => {
      const cw = resolveContextWindow('high', profile, undefined);
      const mot = resolveMaxTokens('high', profile, undefined);
      expect(cw).toBe(60000);
      expect(mot).toBe(4000);
    });
  });

  describe('resolveContextWindow and resolveMaxTokens – additional coverage', () => {
    it('should return default when tier is missing from profile', () => {
      const profile: RouterProfile = {
        high: { model: 'openai/gpt-4o', resolvedContextWindow: 60000, resolvedMaxTokens: 4000 },
      };
      expect(resolveContextWindow('low', profile, undefined)).toBe(128_000);
      expect(resolveMaxTokens('low', profile, undefined)).toBe(16_384);
    });

    it('should fall back to resolvedContextWindow/MaxTokens when registry model has no values', () => {
      const profile: RouterProfile = {
        high: { model: 'openai/gpt-4o', resolvedContextWindow: 60000, resolvedMaxTokens: 4000 },
      };
      const registryNoValues = {
        find: () => ({}),
        getApiKeyAndHeaders: async () => ({ ok: false as const, error: 'not-mocked' }),
      };
      expect(resolveContextWindow('high', profile, registryNoValues as any)).toBe(60000);
      expect(resolveMaxTokens('high', profile, registryNoValues as any)).toBe(4000);
    });

    it('should catch parseCanonicalModelRef errors and return resolved values', () => {
      const profile: RouterProfile = {
        high: { model: 'invalid-no-slash', resolvedContextWindow: 50000, resolvedMaxTokens: 3000 },
      };
      const registryWithFind = {
        find: () => ({ contextWindow: 99999, maxTokens: 8888 }),
        getApiKeyAndHeaders: async () => ({ ok: false as const, error: 'not-mocked' }),
      };
      // parseCanonicalModelRef will throw for 'invalid-no-slash', so it falls through to resolved values
      expect(resolveContextWindow('high', profile, registryWithFind as any)).toBe(50000);
      expect(resolveMaxTokens('high', profile, registryWithFind as any)).toBe(3000);
    });
  });

  describe('collectProfileThinkingLevels', () => {
    it('should collect thinking levels from all tiers', () => {
      const profile: RouterProfile = {
        high: { model: 'openai/gpt-4o', resolvedThinkingLevels: ['high', 'xhigh'] },
        medium: { model: 'openai/gpt-4o-mini', resolvedThinkingLevels: ['medium', 'low'] },
      };
      const levels = collectProfileThinkingLevels(profile);
      expect(levels.has('high')).toBe(true);
      expect(levels.has('xhigh')).toBe(true);
      expect(levels.has('medium')).toBe(true);
      expect(levels.has('low')).toBe(true);
      expect(levels.size).toBe(4);
    });

    it('should return empty set for profile with no tiers', () => {
      const profile: RouterProfile = {};
      const levels = collectProfileThinkingLevels(profile);
      expect(levels.size).toBe(0);
    });

    it('should skip tiers without resolvedThinkingLevels', () => {
      const profile: RouterProfile = {
        high: { model: 'openai/gpt-4o', resolvedThinkingLevels: ['high'] },
        medium: { model: 'openai/gpt-4o-mini' },
      };
      const levels = collectProfileThinkingLevels(profile);
      expect(levels.size).toBe(1);
      expect(levels.has('high')).toBe(true);
    });
  });

  describe('getUnsupportedTiers', () => {
    it('should return tiers that do not include the requested thinking level', () => {
      const profile: RouterProfile = {
        high: { model: 'openai/gpt-4o', resolvedThinkingLevels: ['high', 'xhigh'] },
        medium: { model: 'openai/gpt-4o-mini', resolvedThinkingLevels: ['medium', 'low'] },
        low: { model: 'openai/gpt-4o-micro', resolvedThinkingLevels: ['low'] },
      };
      const unsupported = getUnsupportedTiers(profile, 'xhigh');
      expect(unsupported).toEqual(['medium', 'low']);
    });

    it('should return empty array if all tiers support the level', () => {
      const profile: RouterProfile = {
        high: { model: 'openai/gpt-4o', resolvedThinkingLevels: ['high', 'medium'] },
        medium: { model: 'openai/gpt-4o-mini', resolvedThinkingLevels: ['medium'] },
      };
      const unsupported = getUnsupportedTiers(profile, 'medium');
      expect(unsupported).toEqual([]);
    });

    it('should skip missing tiers (undefined tier config)', () => {
      const profile: RouterProfile = {
        high: { model: 'openai/gpt-4o', resolvedThinkingLevels: ['high'] },
      };
      const unsupported = getUnsupportedTiers(profile, 'low');
      expect(unsupported).toEqual(['high']);
    });

    it('should treat tiers with undefined resolvedThinkingLevels as unsupported', () => {
      const profile: RouterProfile = {
        high: { model: 'openai/gpt-4o' },
        medium: { model: 'openai/gpt-4o-mini', resolvedThinkingLevels: ['medium'] },
      };
      const unsupported = getUnsupportedTiers(profile, 'medium');
      expect(unsupported).toEqual(['high']);
    });
  });

  describe('normalizeConfig – classifier config variants', () => {
    it('should normalize classifierModel as object with valid thinking', () => {
      const raw = {
        profiles: {
          balanced: { high: { model: 'openai/gpt-4o' } },
        },
        classifierModel: { model: 'openai/gpt-4o', thinking: 'low' },
      };
      const { config, warnings } = normalizeConfig(raw as unknown as RouterConfig);
      expect(config.classifierModel?.model).toBe('openai/gpt-4o');
      expect(config.classifierModel?.thinking).toBe('low');
      expect(warnings).toEqual([]);
    });

    it('should warn and ignore invalid thinking on classifierModel object', () => {
      const raw = {
        profiles: {
          balanced: { high: { model: 'openai/gpt-4o' } },
        },
        classifierModel: { model: 'openai/gpt-4o', thinking: 'super-invalid' },
      };
      const { config, warnings } = normalizeConfig(raw as unknown as RouterConfig);
      expect(config.classifierModel?.model).toBe('openai/gpt-4o');
      expect(config.classifierModel?.thinking).toBeUndefined();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('invalid thinking level');
    });

    it('should warn when classifierModel object is missing model field', () => {
      const raw = {
        profiles: {
          balanced: { high: { model: 'openai/gpt-4o' } },
        },
        classifierModel: { thinking: 'high' },
      };
      const { config, warnings } = normalizeConfig(raw as unknown as RouterConfig);
      expect(config.classifierModel).toBeUndefined();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('missing the "model" field');
    });
  });
});
