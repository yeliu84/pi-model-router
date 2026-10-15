import { describe, it, expect, vi } from 'vitest';
import {
  extractTextFromContent,
  extractMessageText,
  getLastUserText,
  getRecentConversationText,
  countToolResults,
  countWords,
  hasImageAttachment,
  containsAny,
  phaseForTier,
  resolveAvailableTier,
  buildRoutingDecision,
  decideRouting,
  runClassifier,
} from './routing';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { RouterModelRegistry, RouterProfile, RoutingRule } from './types';

vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: vi.fn(),
}));

const createAssistantMsg = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'openai-completions',
  provider: 'openai',
  model: 'gpt-4o',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: Date.now(),
});

const createToolResultMsg = (
  toolCallId: string,
  toolName: string,
  text: string,
): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId,
  toolName,
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: Date.now(),
});

describe('routing.ts', () => {
  describe('extractTextFromContent', () => {
    it('should return string directly if content is string', () => {
      expect(extractTextFromContent('hello world')).toBe('hello world');
    });

    it('should extract text and toolCall parts from message structure', () => {
      const parts: Message['content'] = [
        { type: 'text' as const, text: 'some text' },
        { type: 'thinking' as const, thinking: 'some thought' },
        {
          type: 'toolCall' as const,
          id: 'call_1',
          name: 'write_file',
          arguments: { path: 'file.txt' },
        },
      ];
      const result = extractTextFromContent(parts);
      expect(result).toContain('some text');
      expect(result).toContain('some thought');
      expect(result).toContain('write_file {"path":"file.txt"}');
    });
  });

  describe('extractMessageText', () => {
    it('should include sections from system messages in TranscriptContext', () => {
      const systemMessage: Message = {
        role: 'system',
        content: 'Base system instructions',
        sections: {
          tools: 'Available tools section',
          removed: null,
        },
        timestamp: Date.now(),
      };
      expect(extractMessageText(systemMessage)).toBe(
        'Base system instructions\n\nAvailable tools section',
      );
    });
  });

  describe('getLastUserText', () => {
    it('should return empty string if no messages', () => {
      const context: Context = { messages: [] };
      expect(getLastUserText(context)).toBe('');
    });

    it('should extract the last user message text', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'first user', timestamp: Date.now() },
          createAssistantMsg('assistant response'),
          { role: 'user', content: 'second user', timestamp: Date.now() },
          createAssistantMsg('another assistant'),
        ],
      };
      expect(getLastUserText(context)).toBe('second user');
    });
  });

  describe('getRecentConversationText', () => {
    it('should combine last N messages in lowercase and exclude system messages', () => {
      const context: Context = {
        messages: [
          {
            role: 'system',
            content: 'System prompt with Plan: instructions',
            timestamp: Date.now(),
          },
          { role: 'user', content: 'First', timestamp: Date.now() },
          { role: 'user', content: 'Second', timestamp: Date.now() },
          { role: 'user', content: 'Third', timestamp: Date.now() },
        ],
      };
      const result = getRecentConversationText(context, 4);
      expect(result).toBe('first\nsecond\nthird');
      expect(result).not.toContain('plan:');
    });
  });

  describe('countToolResults', () => {
    it('should count messages with role toolResult', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'hey', timestamp: Date.now() },
          createToolResultMsg('1', 't', 'result 1'),
          { role: 'user', content: 'ok', timestamp: Date.now() },
          createToolResultMsg('2', 't', 'result 2'),
        ],
      };
      expect(countToolResults(context)).toBe(2);
    });
  });

  describe('countWords', () => {
    it('should count words correctly', () => {
      expect(countWords('   one two   three\nfour ')).toBe(4);
      expect(countWords('')).toBe(0);
    });
  });

  describe('hasImageAttachment', () => {
    it('should return true if any message contains image part', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                data: 'base64data',
                mimeType: 'image/png',
              },
            ],
            timestamp: Date.now(),
          },
        ],
      };
      expect(hasImageAttachment(context)).toBe(true);
    });

    it('should return false if no image part exists', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'text message', timestamp: Date.now() },
        ],
      };
      expect(hasImageAttachment(context)).toBe(false);
    });
  });

  describe('containsAny', () => {
    it('should check if string contains any keyword', () => {
      expect(containsAny('hello world', ['earth', 'world'])).toBe(true);
      expect(containsAny('hello world', ['mars'])).toBe(false);
    });
  });

  describe('phaseForTier', () => {
    it('should return correct phase for tier', () => {
      expect(phaseForTier('high')).toBe('planning');
      expect(phaseForTier('medium')).toBe('implementation');
      expect(phaseForTier('low')).toBe('lightweight');
    });
  });

  describe('resolveAvailableTier', () => {
    const profile: RouterProfile = {
      medium: { model: 'openai/gpt-4o' },
    };

    it('should return preferred if available', () => {
      expect(
        resolveAvailableTier(
          { high: { model: 'a' }, medium: { model: 'b' } },
          'high',
        ),
      ).toBe('high');
    });

    it('should fall up if preferred is unavailable', () => {
      expect(resolveAvailableTier({ high: { model: 'a' } }, 'low')).toBe(
        'high',
      );
    });

    it('should fall down if falling up finds nothing', () => {
      expect(resolveAvailableTier({ low: { model: 'a' } }, 'medium')).toBe(
        'low',
      );
    });
  });

  describe('buildRoutingDecision', () => {
    const profile: RouterProfile = {
      high: { model: 'openai/gpt-4o-pro', thinking: 'high' },
    };

    it('should construct correct decision object', () => {
      const decision = buildRoutingDecision(
        'balanced',
        profile,
        'high',
        'planning',
        'Reasoning string',
      );
      expect(decision.profile).toBe('balanced');
      expect(decision.tier).toBe('high');
      expect(decision.phase).toBe('planning');
      expect(decision.targetProvider).toBe('openai');
      expect(decision.targetModelId).toBe('gpt-4o-pro');
      expect(decision.targetLabel).toBe('openai/gpt-4o-pro');
      expect(decision.thinking).toBe('high');
      expect(decision.reasoning).toBe('Reasoning string');
    });

    it('should throw if tier is not in profile', () => {
      expect(() =>
        buildRoutingDecision(
          'balanced',
          profile,
          'medium',
          'implementation',
          'Reason',
        ),
      ).toThrow();
    });
  });

  describe('decideRouting', () => {
    const profile: RouterProfile = {
      high: { model: 'openai/gpt-4o', resolvedContextWindow: 100 },
      medium: { model: 'openai/gpt-4o-mini', resolvedContextWindow: 100 },
      low: { model: 'openai/gpt-4o-micro', resolvedContextWindow: 100 },
    };

    const rules: RoutingRule[] = [
      { matches: 'force-high', tier: 'high', reason: 'High rule' },
    ];

    it('should respect manual pinned tier', () => {
      const context: Context = {
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      };
      const decision = decideRouting(context, 'p', profile, undefined, 'high');
      expect(decision.tier).toBe('high');
      expect(decision.reasoning).toContain('Pinned to high tier');
    });

    it('should match custom rule first', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'Please force-high model',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        rules,
      );
      expect(decision.tier).toBe('high');
      expect(decision.isRuleMatched).toBe(true);
      expect(decision.reasoning).toBe('High rule');
    });

    it('should match custom rule case-insensitively', () => {
      const rulesWithCapitalCase = [
        { matches: 'Force-High', tier: 'high' as const, reason: 'High rule' },
      ];
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'Please force-high model',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        rulesWithCapitalCase,
      );
      expect(decision.tier).toBe('high');
      expect(decision.isRuleMatched).toBe(true);
      expect(decision.reasoning).toBe('High rule');
    });

    it('should collect all matching rules and pick the highest tier', () => {
      const rulesWithMultipleMatches = [
        { matches: 'summary', tier: 'low' as const, reason: 'Low rule' },
        { matches: 'refactor', tier: 'high' as const, reason: 'High rule' },
      ];
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'Please summarize the refactor',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        rulesWithMultipleMatches,
      );
      expect(decision.tier).toBe('high');
      expect(decision.isRuleMatched).toBe(true);
      expect(decision.reasoning).toBe('High rule');
    });

    it('should route explicit high/low hints', () => {
      const contextHigh: Context = {
        messages: [
          {
            role: 'user',
            content: 'think hard step by step',
            timestamp: Date.now(),
          },
        ],
      };
      const decisionHigh = decideRouting(contextHigh, 'p', profile, undefined);
      expect(decisionHigh.tier).toBe('high');

      const contextLow: Context = {
        messages: [
          { role: 'user', content: 'fast summary', timestamp: Date.now() },
        ],
      };
      const decisionLow = decideRouting(contextLow, 'p', profile, undefined);
      expect(decisionLow.tier).toBe('low');
    });

    it('should downgrade high to medium if budget is exceeded', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'think hard', timestamp: Date.now() },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        undefined,
        true,
      );
      expect(decision.tier).toBe('medium');
      expect(decision.isBudgetForced).toBe(true);
    });

    it('should maintain planning phase bias (stickiness)', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'how to design this',
            timestamp: Date.now(),
          },
          {
            role: 'user',
            content: 'we should design X',
            timestamp: Date.now(),
          },
          { role: 'user', content: 'why X?', timestamp: Date.now() },
        ],
      };
      const previous = buildRoutingDecision(
        'p',
        profile,
        'high',
        'planning',
        'Initial plan',
      );
      const decision = decideRouting(context, 'p', profile, previous);
      expect(decision.tier).toBe('high');
      expect(decision.phase).toBe('planning');
    });

    it('should keep planning phase bias when previous phase was planning, no tools, and word count > lowThreshold', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content:
              'what about this particular scenario that we discussed earlier today',
            timestamp: Date.now(),
          },
        ],
      };
      const previous = buildRoutingDecision(
        'p',
        profile,
        'high',
        'planning',
        'Previous planning',
      );
      const decision = decideRouting(
        context,
        'p',
        profile,
        previous,
        undefined,
        undefined,
        0.5,
      );
      expect(decision.tier).toBe('high');
      expect(decision.phase).toBe('planning');
      expect(decision.reasoning).toContain('planning-phase bias');
    });

    it('should detect implementation from previous implementation phase', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'ok next step',
            timestamp: Date.now(),
          },
        ],
      };
      const previous = buildRoutingDecision(
        'p',
        profile,
        'medium',
        'implementation',
        'Previous impl',
      );
      const decision = decideRouting(context, 'p', profile, previous);
      expect(decision.tier).toBe('medium');
      expect(decision.phase).toBe('implementation');
      expect(decision.reasoning).toContain('implementation');
    });

    it('should detect implementation from toolResultCount > 0', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'ok next step',
            timestamp: Date.now(),
          },
          createToolResultMsg('1', 'read_file', 'file contents'),
          {
            role: 'user',
            content: 'looks good proceed',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(context, 'p', profile, undefined);
      expect(decision.tier).toBe('medium');
      expect(decision.phase).toBe('implementation');
      expect(decision.reasoning).toContain('implementation');
    });

    it('should detect implementation from recent conversation containing plan:', () => {
      const context: Context = {
        messages: [
          createAssistantMsg('Plan:\n1. Do X\n2. Do Y'),
          {
            role: 'user',
            content: 'sounds good lets go',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(context, 'p', profile, undefined);
      expect(decision.tier).toBe('medium');
      expect(decision.phase).toBe('implementation');
      expect(decision.reasoning).toContain('implementation');
    });

    it('should default to medium tier when no heuristic rules match for moderate-length prompts', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content:
              'i wonder about some random topic that doesnt match any particular keyword category here today now',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(context, 'p', profile, undefined);
      expect(decision.tier).toBe('medium');
      expect(decision.reasoning).toContain('Defaulted to medium');
    });
  });

  describe('runClassifier', () => {
    const createClassifierModel = (
      provider: string,
      id: string,
    ): Model<Api> => ({
      id,
      name: id,
      api: 'openai-completions',
      provider,
      baseUrl: 'https://api.openai.com/v1',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 4096,
    });

    const createTextDeltaStream = (
      ...deltas: string[]
    ): AssistantMessageEventStream => {
      const stream = createAssistantMessageEventStream();
      const partial = createAssistantMsg('');
      for (const delta of deltas) {
        stream.push({ type: 'text_delta', contentIndex: 0, delta, partial });
      }
      stream.end(partial);
      return stream;
    };

    const mockRegistry: RouterModelRegistry = {
      find: (provider: string, modelId: string) => {
        if (provider === 'openai' && modelId === 'gpt-4o') {
          return createClassifierModel(provider, modelId);
        }
        return undefined;
      },
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: 'test-key',
        headers: {},
      }),
    };

    const context: Context = {
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
    };

    it('should return parsed classification result from stream delta', async () => {
      const mockStream = createTextDeltaStream(
        'Tier: high\n',
        'Reasoning: Needs deep reasoner.',
      );
      vi.mocked(streamSimple).mockReturnValue(mockStream);

      const result = await runClassifier(
        'openai/gpt-4o',
        mockRegistry,
        context,
        'planning',
        'high',
      );
      expect(result).toEqual({
        tier: 'high',
        reasoning: 'Needs deep reasoner.',
      });
    });

    it('should return undefined if stream fails or format is invalid', async () => {
      const mockStream = createTextDeltaStream('Invalid response format');
      vi.mocked(streamSimple).mockReturnValue(mockStream);

      const result = await runClassifier(
        'openai/gpt-4o',
        mockRegistry,
        context,
      );
      expect(result).toBeUndefined();
    });

    it('should accept headers-only authentication in runClassifier', async () => {
      const headersOnlyRegistry: RouterModelRegistry = {
        find: (provider: string, modelId: string) =>
          createClassifierModel(provider, modelId),
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: undefined,
          headers: { Authorization: 'Bearer kimi-oauth-token' },
        }),
      };

      const mockStream = createTextDeltaStream(
        'Tier: low\n',
        'Reasoning: Short lookup.',
      );
      vi.mocked(streamSimple).mockReturnValue(mockStream);

      const result = await runClassifier(
        'kimi-coding/k3',
        headersOnlyRegistry,
        context,
      );
      expect(result).toEqual({
        tier: 'low',
        reasoning: 'Short lookup.',
      });
    });

    it('should merge model.headers with auth.headers and run classifier without apiKey', async () => {
      const mockStream = createTextDeltaStream(
        'Tier: low\n',
        'Reasoning: Simple greeting.',
      );
      vi.mocked(streamSimple).mockReturnValue(mockStream);

      const customHeadersRegistry: RouterModelRegistry = {
        find: (provider: string, modelId: string) => {
          if (provider === 'openai' && modelId === 'gpt-4o') {
            return {
              ...createClassifierModel(provider, modelId),
              headers: {
                'cf-aig-authorization': 'Bearer cf-token',
                'x-custom': 'from-model',
              },
            };
          }
          return undefined;
        },
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: undefined,
          headers: {
            'x-custom': 'from-auth',
          },
        }),
      };

      const result = await runClassifier(
        'openai/gpt-4o',
        customHeadersRegistry,
        context,
      );
      expect(result).toEqual({
        tier: 'low',
        reasoning: 'Simple greeting.',
      });
      expect(streamSimple).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'gpt-4o' }),
        expect.anything(),
        expect.objectContaining({
          apiKey: undefined,
          headers: {
            'cf-aig-authorization': 'Bearer cf-token',
            'x-custom': 'from-auth',
          },
        }),
      );
    });

    it('should override model.baseUrl with auth.baseUrl when running classifier (e.g. GitHub Copilot proxy-ep)', async () => {
      const mockStream = createTextDeltaStream(
        'Tier: low\n',
        'Reasoning: Copilot classifier.',
      );
      vi.mocked(streamSimple).mockReturnValue(mockStream);

      const copilotRegistry: RouterModelRegistry = {
        ...mockRegistry,
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: 'copilot-oauth-token',
          headers: {},
          baseUrl: 'https://api.enterprise.githubcopilot.com',
        }),
      };

      const result = await runClassifier(
        'openai/gpt-4o',
        copilotRegistry,
        context,
      );
      expect(result).toEqual({
        tier: 'low',
        reasoning: 'Copilot classifier.',
      });
      expect(streamSimple).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'gpt-4o',
          baseUrl: 'https://api.enterprise.githubcopilot.com',
        }),
        expect.anything(),
        expect.objectContaining({
          apiKey: 'copilot-oauth-token',
        }),
      );
    });

    it('should use custom registered provider streamSimple when available', async () => {
      vi.mocked(streamSimple).mockClear();
      const customStreamFn = vi
        .fn()
        .mockReturnValue(
          createTextDeltaStream(
            'Tier: medium\n',
            'Reasoning: Custom provider classifier.',
          ),
        );
      const customProviderRegistry: RouterModelRegistry = {
        ...mockRegistry,
        getRegisteredProviderConfig: vi.fn().mockReturnValue({
          api: 'openai-completions',
          streamSimple: customStreamFn,
        }),
      };

      const result = await runClassifier(
        'openai/gpt-4o',
        customProviderRegistry,
        context,
      );
      expect(result).toEqual({
        tier: 'medium',
        reasoning: 'Custom provider classifier.',
      });
      expect(customStreamFn).toHaveBeenCalled();
      expect(streamSimple).not.toHaveBeenCalled();
    });
  });
});
