import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerRouterProvider,
  createErrorMessage,
  waitForRegistry,
} from './provider';
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Provider,
} from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type {
  ExtensionAPI,
  ProviderConfig,
} from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  RouterConfig,
  RoutingDecision,
  RouterModelRegistry,
  RouterPinByProfile,
  RouterThinkingByProfile,
} from './types';

vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: vi.fn(),
}));

const createFailingStream = (
  errorMessage: string,
): AssistantMessageEventStream => {
  const s = createAssistantMessageEventStream();
  return Object.assign(s, {
    async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
      throw new Error(errorMessage);
    },
  });
};

const createTestModel = (overrides: Partial<Model<Api>> = {}): Model<Api> => ({
  id: 'gpt-4o',
  name: 'GPT-4o',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 4096,
  ...overrides,
});

const createAssistantMsg = (
  text: string,
  totalCost = 0,
): AssistantMessage => ({
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
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: totalCost,
    },
  },
  stopReason: 'stop',
  timestamp: Date.now(),
});

const createDelegateStream = (
  text: string,
  totalCost = 0,
): AssistantMessageEventStream => {
  const s = createAssistantMessageEventStream();
  const msg = createAssistantMsg(text, totalCost);
  s.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: msg });
  s.push({ type: 'done', reason: 'stop', message: msg });
  s.end(msg);
  return s;
};

interface TestExtensionContext {
  ui: {
    setHiddenThinkingLabel: (label?: string) => void;
  };
}

interface TestProviderState {
  lastRegisteredModels: string;
  currentConfig: RouterConfig;
  currentModelRegistry: RouterModelRegistry | undefined;
  lastExtensionContext: TestExtensionContext | undefined;
  selectedProfile: string | undefined;
  routerEnabled: boolean;
  lastDecision: RoutingDecision | undefined;
  thinkingByProfile: RouterThinkingByProfile;
  pinnedTierByProfile: RouterPinByProfile;
  accumulatedCost: number;
  registryTimeoutMs?: number;
}

describe('provider.ts', () => {
  let mockPi: Pick<ExtensionAPI, 'registerProvider'>;
  let mockState: TestProviderState;
  let mockActions: Parameters<
    typeof registerRouterProvider<TestExtensionContext>
  >[2];
  let registeredProviderName: string | null = null;
  let registeredProviderOptions: ProviderConfig | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    registeredProviderName = null;
    registeredProviderOptions = null;

    mockPi = {
      registerProvider: (
        nameOrProvider: string | Provider,
        options?: ProviderConfig,
      ) => {
        if (typeof nameOrProvider === 'string' && options) {
          registeredProviderName = nameOrProvider;
          registeredProviderOptions = options;
        }
      },
    };

    const config: RouterConfig = {
      profiles: {
        balanced: {
          high: { model: 'openai/gpt-4o', resolvedContextWindow: 10000 },
          medium: {
            model: 'openai/gpt-4o-mini',
            resolvedContextWindow: 5000,
            fallbacks: ['google/gemini-1.5-flash'],
          },
        },
      },
    };

    const mockRegistry: RouterModelRegistry = {
      find: (provider: string, modelId: string) => {
        if (provider === 'openai' || provider === 'google') {
          return createTestModel({
            provider,
            id: modelId,
            input: ['text', 'image'],
            contextWindow: modelId === 'gpt-4o-mini' ? 5000 : 10000,
          });
        }
        return undefined;
      },
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: 'test-key',
        headers: {},
      }),
    };

    mockState = {
      lastRegisteredModels: '',
      currentConfig: config,
      currentModelRegistry: mockRegistry,
      lastExtensionContext: {
        ui: {
          setHiddenThinkingLabel: vi.fn(),
        },
      },
      selectedProfile: undefined,
      routerEnabled: false,
      lastDecision: undefined,
      thinkingByProfile: {},
      pinnedTierByProfile: {},
      accumulatedCost: 0,
    };

    mockActions = {
      persistState: vi.fn(),
      recordDebugDecision: vi.fn(),
      getThinkingOverride: vi.fn().mockReturnValue(undefined),
      updateStatus: vi.fn(),
      syncPiThinkingLevel: vi.fn(),
    };
  });

  describe('createErrorMessage', () => {
    it('should create a valid error AssistantMessage', () => {
      const model = createTestModel({ provider: 'openai', id: 'gpt-4o' });
      const msg = createErrorMessage(model, 'Test error message');
      expect(msg.role).toBe('assistant');
      expect(msg.errorMessage).toBe('Test error message');
      expect(msg.stopReason).toBe('error');
    });
  });

  describe('registerRouterProvider', () => {
    it('should register provider under router name', () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      expect(registeredProviderName).toBe('router');
      expect(registeredProviderOptions).toBeDefined();
      expect(registeredProviderOptions!.models![0].id).toBe('balanced');
    });

    it('should delegate streams and accumulate cost on success', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);

      vi.mocked(streamSimple).mockReturnValue(
        createDelegateStream('Answer part', 0.0015),
      );

      const model = createTestModel({
        id: 'balanced',
        provider: 'router',
      });
      const context = normalizeContext({
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      });

      registeredProviderOptions!.streamSimple!(model, context);

      // Wait for async execution of stream handler
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockState.selectedProfile).toBe('balanced');
      expect(mockState.routerEnabled).toBe(true);
      expect(mockState.accumulatedCost).toBe(0.0015);
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should try fallbacks if the primary model fails', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);

      let callCount = 0;
      vi.mocked(streamSimple).mockImplementation((model: Model<Api>) => {
        callCount++;
        if (model.id === 'gpt-4o-mini') {
          return createFailingStream('primary failed');
        }
        return createDelegateStream('fallback answer', 0.0005);
      });

      // Force a medium tier routing decision
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = createTestModel({
        id: 'balanced',
        provider: 'router',
      });
      const context = normalizeContext({
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      });

      registeredProviderOptions!.streamSimple!(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(callCount).toBe(2);
      expect(mockState.accumulatedCost).toBe(0.0005);
      expect(mockState.lastDecision!.isFallback).toBe(true);
    });

    it('should preserve previous Google model on Google thinking tool continuation', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      vi.mocked(streamSimple).mockReturnValue(createDelegateStream('done'));

      // Set up last decision as Google model with thinking
      mockState.lastDecision = {
        profile: 'balanced',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        thinking: 'high',
        reasoning: 'initial google model reasoning',
        timestamp: Date.now(),
      };

      // Configure profile tiers to use google provider models
      mockState.currentConfig.profiles.balanced.high = {
        model: 'google/gemini-2.5-pro',
        thinking: 'high' as ThinkingLevel,
      };
      mockState.currentConfig.profiles.balanced.medium = {
        model: 'google/gemini-2.5-flash',
        thinking: 'medium' as ThinkingLevel,
      };

      // Set up registry search
      mockState.currentModelRegistry!.find = (
        provider: string,
        modelId: string,
      ) =>
        createTestModel({
          provider,
          id: modelId,
          reasoning: true,
          input: ['text'],
        });

      const model = createTestModel({
        id: 'balanced',
        provider: 'router',
      });
      const context = normalizeContext({
        messages: [
          { role: 'user', content: 'initial', timestamp: Date.now() },
          {
            role: 'toolResult',
            toolCallId: 'c1',
            toolName: 't',
            content: [{ type: 'text', text: 'tool output' }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      });

      registeredProviderOptions!.streamSimple!(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // The decision should be updated to preserve the previous model
      expect(mockState.lastDecision!.targetModelId).toBe('gemini-2.5-pro');
      expect(mockState.lastDecision!.reasoning).toContain(
        'Preserved google/gemini-2.5-pro for a Google tool-result continuation',
      );
    });

    it('should force higher tier if current tier does not support image attachments', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      vi.mocked(streamSimple).mockReturnValue(createDelegateStream('done'));

      // Define medium tier model and fallback without image support, high tier model with image support
      mockState.currentModelRegistry!.find = (
        provider: string,
        modelId: string,
      ) => {
        if (modelId === 'gpt-4o') {
          return createTestModel({
            provider,
            id: modelId,
            input: ['text', 'image'],
          });
        }
        return createTestModel({
          provider,
          id: modelId,
          input: ['text'],
        });
      };

      // Force a medium tier routing decision originally
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = createTestModel({
        id: 'balanced',
        provider: 'router',
      });
      const context = normalizeContext({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                mimeType: 'image/png',
                data: 'data',
              },
            ],
            timestamp: Date.now(),
          },
        ],
      });

      registeredProviderOptions!.streamSimple!(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // It should force switch to high tier because medium doesn't support images
      expect(mockState.lastDecision!.tier).toBe('high');
      expect(mockState.lastDecision!.reasoning).toContain(
        'Forced high tier because the originally routed medium tier does not support image attachments',
      );
    });

    it('should auto-truncate context if target limit is smaller than reported context window', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);

      let truncatedContextPassed: Context | null = null;
      vi.mocked(streamSimple).mockImplementation(
        (_model: Model<Api>, ctx: Context) => {
          truncatedContextPassed = ctx;
          return createDelegateStream('done');
        },
      );

      // Medium tier model has resolvedContextWindow = 5000 in config.
      // But let's verify if reported max context window of router is larger (which is 10000 from high tier).
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = createTestModel({
        id: 'balanced',
        provider: 'router',
        contextWindow: 10000,
      });

      // Let's create a large context that exceeds 5000 tokens (approx 15000 chars)
      const context = normalizeContext({
        systemPrompt: 'System prompt instructions',
        messages: [
          { role: 'user', content: 'a'.repeat(8000), timestamp: Date.now() },
          { role: 'user', content: 'b'.repeat(8000), timestamp: Date.now() },
          { role: 'user', content: 'c'.repeat(2000), timestamp: Date.now() },
        ],
      });

      registeredProviderOptions!.streamSimple!(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(truncatedContextPassed).toBeDefined();
      // Old messages should have been truncated to fit 5000 tokens limit (15000 chars approx)
      // The first user message 'a'.repeat(8000) should have been dropped while preserving system & latest.
      expect(truncatedContextPassed!.messages.length).toBeLessThan(
        context.messages.length,
      );
      expect(
        truncatedContextPassed!.messages[
          truncatedContextPassed!.messages.length - 1
        ].content,
      ).toBe('c'.repeat(2000));
    });

    it('should preserve system messages in TranscriptContext during auto-truncation', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);

      let truncatedContextPassed: Context | null = null;
      vi.mocked(streamSimple).mockImplementation(
        (_model: Model<Api>, ctx: Context) => {
          truncatedContextPassed = ctx;
          return createDelegateStream('done');
        },
      );

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = createTestModel({
        id: 'balanced',
        provider: 'router',
        contextWindow: 10000,
      });

      const context = normalizeContext({
        messages: [
          {
            role: 'system',
            content: '',
            sections: { main: 'System prompt instructions' },
            timestamp: 0,
          },
          { role: 'user', content: 'a'.repeat(8000), timestamp: Date.now() },
          { role: 'user', content: 'b'.repeat(8000), timestamp: Date.now() },
          { role: 'user', content: 'c'.repeat(2000), timestamp: Date.now() },
        ],
      });

      registeredProviderOptions!.streamSimple!(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(truncatedContextPassed).toBeDefined();
      expect(truncatedContextPassed!.messages[0].role).toBe('system');
      expect(truncatedContextPassed!.messages.length).toBe(3);
      expect(truncatedContextPassed!.messages[1].content).toBe('b'.repeat(8000));
      expect(truncatedContextPassed!.messages[2].content).toBe('c'.repeat(2000));
    });

    it('should push error event when currentModelRegistry never becomes available', async () => {
      mockState.currentModelRegistry = undefined;
      mockState.registryTimeoutMs = 100; // Use short timeout for test
      registerRouterProvider(mockPi, mockState, mockActions);

      const model = createTestModel({
        id: 'balanced',
        provider: 'router',
      });
      const context = normalizeContext({
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      });

      const stream = registeredProviderOptions!.streamSimple!(model, context);
      const result = await stream.result();

      expect(result.stopReason).toBe('error');
      expect(result.errorMessage).toContain('timed out');
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should wait and succeed when currentModelRegistry becomes available after a delay', async () => {
      mockState.currentModelRegistry = undefined;
      mockState.registryTimeoutMs = 500;
      const mockRegistry: RouterModelRegistry = {
        find: (provider: string, modelId: string) => {
          if (provider === 'openai' || provider === 'google') {
            return createTestModel({
              provider,
              id: modelId,
              input: ['text', 'image'],
            });
          }
          return undefined;
        },
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: 'test-key',
          headers: {},
        }),
      };

      registerRouterProvider(mockPi, mockState, mockActions);

      vi.mocked(streamSimple).mockReturnValue(
        createDelegateStream('Answer', 0.001),
      );

      const model = createTestModel({
        id: 'balanced',
        provider: 'router',
      });
      const context = normalizeContext({
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      });

      registeredProviderOptions!.streamSimple!(model, context);

      // Simulate session_start setting the registry after 10ms
      setTimeout(() => {
        mockState.currentModelRegistry = mockRegistry;
      }, 10);

      await vi.waitFor(
        () => {
          expect(mockState.routerEnabled).toBe(true);
          expect(mockState.selectedProfile).toBe('balanced');
        },
        { timeout: 1000 },
      );
    });

    it('should push error event when profile is unknown', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);

      const model = createTestModel({
        id: 'nonexistent-profile',
        provider: 'router',
      });
      const context = normalizeContext({
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      });

      const stream = registeredProviderOptions!.streamSimple!(model, context);
      const result = await stream.result();

      expect(result.stopReason).toBe('error');
      expect(result.errorMessage).toContain('Unknown router profile');
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should fall back when auth fails for primary model', async () => {
      let authCallCount = 0;
      mockState.currentModelRegistry!.getApiKeyAndHeaders = async (
        model: Model<Api>,
      ) => {
        authCallCount++;
        if (model.id === 'gpt-4o-mini') {
          return { ok: false, error: 'auth-error' };
        }
        return { ok: true, apiKey: 'fallback-key', headers: {} };
      };

      registerRouterProvider(mockPi, mockState, mockActions);

      vi.mocked(streamSimple).mockReturnValue(
        createDelegateStream('fallback answer', 0.001),
      );

      // Pin to medium so primary is gpt-4o-mini with fallback gemini-1.5-flash
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = createTestModel({
        id: 'balanced',
        provider: 'router',
      });
      const context = normalizeContext({
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      });

      registeredProviderOptions!.streamSimple!(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(authCallCount).toBeGreaterThanOrEqual(2);
      expect(mockState.accumulatedCost).toBe(0.001);
    });

    it('should skip model not found in registry and try fallback', async () => {
      mockState.currentModelRegistry!.find = (
        provider: string,
        modelId: string,
      ) => {
        if (modelId === 'gpt-4o-mini') return undefined; // primary not found
        return createTestModel({
          provider,
          id: modelId,
          input: ['text', 'image'],
        });
      };

      registerRouterProvider(mockPi, mockState, mockActions);

      vi.mocked(streamSimple).mockReturnValue(
        createDelegateStream('answer from fallback', 0.002),
      );

      // Pin to medium so primary is gpt-4o-mini with fallback gemini-1.5-flash
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = createTestModel({
        id: 'balanced',
        provider: 'router',
      });
      const context = normalizeContext({
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      });

      registeredProviderOptions!.streamSimple!(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockState.accumulatedCost).toBe(0.002);
      expect(mockState.lastDecision!.isFallback).toBe(true);
    });

    it('should push error when all models in chain fail', async () => {
      vi.mocked(streamSimple).mockImplementation(() =>
        createFailingStream('model unavailable'),
      );

      registerRouterProvider(mockPi, mockState, mockActions);

      // Pin to medium to get fallback chain
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = createTestModel({
        id: 'balanced',
        provider: 'router',
      });
      const context = normalizeContext({
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      });

      const stream = registeredProviderOptions!.streamSimple!(model, context);
      const result = await stream.result();

      expect(result.stopReason).toBe('error');
      expect(result.errorMessage).toContain('model unavailable');
      expect(mockActions.persistState).toHaveBeenCalled();
    });
  });

  describe('waitForRegistry', () => {
    it('should return registry immediately if already available', async () => {
      const mockRegistry = { find: vi.fn() };
      const state = { currentModelRegistry: mockRegistry };
      const result = await waitForRegistry(state, 1000);
      expect(result).toBe(mockRegistry);
    });

    it('should wait and return registry when it becomes available', async () => {
      const mockRegistry = { find: vi.fn() };
      const state: { currentModelRegistry: typeof mockRegistry | undefined } = {
        currentModelRegistry: undefined,
      };

      // Set registry after 100ms
      setTimeout(() => {
        state.currentModelRegistry = mockRegistry;
      }, 100);

      const result = await waitForRegistry(state, 2000);
      expect(result).toBe(mockRegistry);
    });

    it('should return undefined after timeout if registry never becomes available', async () => {
      const state = { currentModelRegistry: undefined };
      const result = await waitForRegistry(state, 300);
      expect(result).toBeUndefined();
    });
  });
});