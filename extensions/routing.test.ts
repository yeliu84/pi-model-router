import { describe, it, expect, vi } from 'vitest';
import {
  extractTextFromContent,
  extractMessageText,
  getLastUserText,
  getRecentConversationText,
  countToolResults,
  countWords,
  hasImageAttachment,
  extractLastUserImages,
  containsAny,
  phaseForTier,
  tierForPhase,
  resolveAvailableTier,
  buildRoutingDecision,
  decideRouting,
  runClassifier,
  runNativeClassifier,
  selectClassifierImages,
} from './routing';
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type ClassifierApi,
  type ClassifierModel,
  type ClassifierResult,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { RouterModelRegistry, RouterProfile, RoutingRule } from './types';

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

    it('should ignore redacted thinking blocks', () => {
      const parts: Message['content'] = [
        { type: 'text' as const, text: 'visible answer' },
        {
          type: 'thinking' as const,
          thinking: '[Reasoning redacted]',
          redacted: true,
        },
      ];
      const result = extractTextFromContent(parts);
      expect(result).toBe('visible answer');
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
      streamSimple: vi.fn(),
    };

    const context: Context = {
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
    };

    it('should return parsed classification result from stream delta', async () => {
      const mockStream = createTextDeltaStream(
        'Tier: high\n',
        'Reasoning: Needs deep reasoner.',
      );
      const registryStreamSimple = vi.fn().mockReturnValue(mockStream);

      const result = await runClassifier(
        'openai/gpt-4o',
        { ...mockRegistry, streamSimple: registryStreamSimple },
        context,
        'planning',
        'high',
      );
      expect(result).toEqual({
        tier: 'high',
        reasoning: 'Needs deep reasoner.',
      });
      expect(registryStreamSimple).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', id: 'gpt-4o' }),
        expect.anything(),
        expect.objectContaining({ reasoning: 'high' }),
      );
    });

    it('should return undefined if stream fails or format is invalid', async () => {
      const mockStream = createTextDeltaStream('Invalid response format');
      const registryStreamSimple = vi.fn().mockReturnValue(mockStream);

      const result = await runClassifier(
        'openai/gpt-4o',
        { ...mockRegistry, streamSimple: registryStreamSimple },
        context,
      );
      expect(result).toBeUndefined();
    });

    it('should classify using Pi native classifier model via findOfType and classify()', async () => {
      const nativeClassifier: ClassifierModel<ClassifierApi> = {
        type: 'classifier',
        id: 'jev-latest',
        name: 'Jev Latest',
        api: 'typesafe-system-one',
        provider: 'typesafe',
        baseUrl: 'https://api.typesafe.ai',
        input: ['text'],
        contextWindow: 32000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };

      const classifyResult: ClassifierResult = {
        api: 'typesafe-system-one',
        provider: 'typesafe',
        model: 'jev-latest',
        stopReason: 'stop',
        timestamp: Date.now(),
        usage: {
          input: 100,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 101,
          cost: {
            input: 0.0001,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.0001,
          },
        },
        answers: {
          tier: {
            type: 'choice',
            choice: 'high',
            probabilities: { high: 0.82, medium: 0.14, low: 0.04 },
            confidence: 0.73,
          },
        },
      };

      const classifyFn = vi.fn().mockResolvedValue(classifyResult);
      const nativeRegistry: RouterModelRegistry = {
        ...mockRegistry,
        findOfType: vi.fn().mockReturnValue(nativeClassifier),
        classify: classifyFn,
      };

      const result = await runClassifier(
        'typesafe/jev-latest',
        nativeRegistry,
        context,
        'planning',
      );

      expect(classifyFn).toHaveBeenCalled();
      expect(result).toEqual({
        tier: 'high',
        reasoning: 'typesafe/jev-latest selected high (p=82%, conf=73%).',
        cost: 0.0001,
      });
    });

    it('should support "auto" classifierModel via getAvailableOfType("classifier")', async () => {
      const lunaClassifier: ClassifierModel<ClassifierApi> = {
        type: 'classifier',
        id: 'gpt-6-luna',
        name: 'GPT-6 Luna',
        api: 'openai-decisions',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        input: ['text', 'image'],
        contextWindow: 922000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };

      const classifyFn = vi.fn().mockResolvedValue({
        api: 'openai-decisions',
        provider: 'openai',
        model: 'gpt-6-luna',
        stopReason: 'stop',
        timestamp: Date.now(),
        answers: {
          tier: {
            type: 'choice',
            choice: 'low',
            probabilities: { high: 0.05, medium: 0.15, low: 0.8 },
            confidence: 0.7,
          },
        },
      } satisfies ClassifierResult);

      const autoRegistry: RouterModelRegistry = {
        ...mockRegistry,
        getAvailableOfType: vi.fn().mockResolvedValue([lunaClassifier]),
        classify: classifyFn,
      };

      const imageContext: Context = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this screenshot?' },
              { type: 'image', data: 'base64img', mimeType: 'image/png' },
            ],
            timestamp: Date.now(),
          },
        ],
      };

      const result = await runClassifier('auto', autoRegistry, imageContext);
      expect(result).toEqual({
        tier: 'low',
        reasoning: 'openai/gpt-6-luna selected low (p=80%, conf=70%).',
      });
      // Since lunaClassifier supports 'image', images should be passed to classify()
      expect(classifyFn).toHaveBeenCalledWith(
        lunaClassifier,
        expect.objectContaining({
          images: [{ type: 'image', data: 'base64img', mimeType: 'image/png' }],
        }),
        undefined,
      );
    });

    it('should apply phaseBias to borderline low-confidence native classifier probabilities', async () => {
      const nativeClassifier: ClassifierModel<ClassifierApi> = {
        type: 'classifier',
        id: 'jev-latest',
        name: 'Jev Latest',
        api: 'typesafe-system-one',
        provider: 'typesafe',
        baseUrl: 'https://api.typesafe.ai',
        input: ['text'],
        contextWindow: 32000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };

      const classifyFn = vi.fn().mockResolvedValue({
        api: 'typesafe-system-one',
        provider: 'typesafe',
        model: 'jev-latest',
        stopReason: 'stop',
        timestamp: Date.now(),
        answers: {
          tier: {
            type: 'choice',
            choice: 'medium',
            probabilities: { high: 0.44, medium: 0.46, low: 0.1 },
            confidence: 0.19,
          },
        },
      } satisfies ClassifierResult);

      const nativeRegistry: RouterModelRegistry = {
        ...mockRegistry,
        findOfType: vi.fn().mockReturnValue(nativeClassifier),
        classify: classifyFn,
      };

      const result = await runNativeClassifier(
        'typesafe/jev-latest',
        nativeRegistry,
        context,
        'planning',
        0.5,
      );

      expect(result).toEqual({
        tier: 'high',
        reasoning:
          'typesafe/jev-latest selected high (p=44%, conf=19%) [phase-biased from medium].',
      });
    });

    it('should filter unsupported image MIME types, cap at 4 images, and retry text-only if image classification fails', async () => {
      const jevClassifier: ClassifierModel<'typesafe-system-one'> = {
        type: 'classifier',
        id: 'jev-latest',
        name: 'Jev Latest',
        api: 'typesafe-system-one',
        provider: 'typesafe',
        baseUrl: 'https://api.typesafe.ai',
        input: ['text', 'image'],
        contextWindow: 32000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };

      const clefClassifier: ClassifierModel<'cloudflare-workers-ai-system-one'> =
        {
          type: 'classifier',
          id: '@cf/cloudflare/clef-omni',
          name: 'Clef Omni',
          api: 'cloudflare-workers-ai-system-one',
          provider: 'cloudflare-workers-ai',
          baseUrl: 'https://api.cloudflare.com/client/v4/accounts/acc/ai',
          input: ['text', 'image'],
          contextWindow: 65536,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { imageInput: 'images' },
        };

      const sampleImages: ImageContent[] = [
        { type: 'image', data: '1', mimeType: 'image/png' },
        { type: 'image', data: '2', mimeType: 'image/webp' },
        { type: 'image', data: '3', mimeType: 'image/gif' },
        { type: 'image', data: '4', mimeType: 'image/jpeg' },
        { type: 'image', data: '5', mimeType: 'image/png' },
        { type: 'image', data: '6', mimeType: 'image/jpeg' },
      ];

      // Jev (assets format) only accepts PNG and JPEG
      expect(
        selectClassifierImages(jevClassifier, sampleImages).map(
          (i) => i.mimeType,
        ),
      ).toEqual(['image/png', 'image/jpeg', 'image/png', 'image/jpeg']);

      // Clef (images format) accepts PNG, JPEG, WebP up to 4 images
      expect(
        selectClassifierImages(clefClassifier, sampleImages).map((i) => i.data),
      ).toEqual(['1', '2', '4', '5']);

      // When classify() fails with stopReason='error' on images, retry text-only
      const classifyFn = vi
        .fn()
        .mockResolvedValueOnce({
          api: 'typesafe-system-one',
          provider: 'typesafe',
          model: 'jev-latest',
          stopReason: 'error',
          errorMessage: 'Experimental image input failed',
          timestamp: Date.now(),
          answers: {},
        } satisfies ClassifierResult)
        .mockResolvedValueOnce({
          api: 'typesafe-system-one',
          provider: 'typesafe',
          model: 'jev-latest',
          stopReason: 'stop',
          timestamp: Date.now(),
          answers: {
            tier: {
              type: 'choice',
              choice: 'medium',
              probabilities: { high: 0.1, medium: 0.8, low: 0.1 },
              confidence: 0.75,
            },
          },
        } satisfies ClassifierResult);

      const imageCtx: Context = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Implement the button layout' },
              { type: 'image', data: 'pngdata', mimeType: 'image/png' },
            ],
            timestamp: Date.now(),
          },
        ],
      };

      const result = await runNativeClassifier(
        'typesafe/jev-latest',
        {
          ...mockRegistry,
          findOfType: vi.fn().mockReturnValue(jevClassifier),
          classify: classifyFn,
        },
        imageCtx,
      );

      expect(classifyFn).toHaveBeenCalledTimes(2);
      expect(classifyFn.mock.calls[0][1]).toHaveProperty('images');
      expect(classifyFn.mock.calls[1][1]).not.toHaveProperty('images');
      expect(result?.tier).toBe('medium');
    });

    it('should extractLastUserImages and tierForPhase accurately', () => {
      expect(tierForPhase('planning')).toBe('high');
      expect(tierForPhase('implementation')).toBe('medium');
      expect(tierForPhase('lightweight')).toBe('low');

      const ctxWithImg: Context = {
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', data: 'abc', mimeType: 'image/jpeg' }],
            timestamp: Date.now(),
          },
        ],
      };
      expect(extractLastUserImages(ctxWithImg)).toHaveLength(1);
      expect(extractLastUserImages(context)).toEqual([]);
    });
  });
});
