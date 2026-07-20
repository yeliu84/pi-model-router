import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerRouterProvider, createErrorMessage, waitForRegistry } from './provider';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { Api, Context, Model, AssistantMessageEventStream, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { RouterConfig, RoutingDecision, RouterTier } from './types';

interface MockEvent {
  type: string;
  delta?: string;
  error?: { errorMessage?: string };
  message?: { usage?: { cost?: { total: number } } };
}

class MockEventStream {
  events: MockEvent[] = [];

  push(event: MockEvent) {
    this.events.push(event);
  }

  end() {}
}

vi.mock('@earendil-works/pi-ai', () => ({
  createAssistantMessageEventStream: vi.fn(),
}));

vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: vi.fn(),
}));

type ProviderState = Parameters<typeof registerRouterProvider>[1];
type ProviderActions = Parameters<typeof registerRouterProvider>[2];
type MutableProviderState = { -readonly [K in keyof ProviderState]: ProviderState[K] };

interface RegisteredProviderOptions {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: {
    id: string;
    name: string;
    reasoning: boolean;
    input: readonly ('text' | 'image')[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    thinkingLevelMap?: Record<string, string>;
  }[];
  streamSimple: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
}

describe('provider.ts', () => {
  let mockPi: ExtensionAPI;
  let mockState: MutableProviderState;
  let mockActions: ProviderActions;
  let registeredProviderName: string | null = null;
  let registeredProviderOptions: RegisteredProviderOptions | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    registeredProviderName = null;
    registeredProviderOptions = null;

    mockPi = {
      registerProvider: (name: string, options: Parameters<ExtensionAPI['registerProvider']>[1]) => {
        registeredProviderName = name;
        registeredProviderOptions = options as unknown as RegisteredProviderOptions;
      },
    } as unknown as ExtensionAPI;

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

    const mockRegistry = {
      find: (provider: string, modelId: string) => {
        if (provider === 'openai' || provider === 'google') {
          return { provider, id: modelId, input: ['text', 'image'] as const } as unknown as Model<Api>;
        }
        return undefined;
      },
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: 'test-key',
        headers: {},
      }),
    } as unknown as ExtensionContext['modelRegistry'];

    mockState = {
      lastRegisteredModels: '',
      currentConfig: config,
      currentModelRegistry: mockRegistry,
      lastExtensionContext: {
        ui: {
          setHiddenThinkingLabel: vi.fn(),
        },
      } as unknown as ExtensionContext,
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
      const model = { api: 'openai' as Api, provider: 'openai', id: 'gpt-4o' } as unknown as Model<Api>;
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
      expect(registeredProviderOptions!.models[0].id).toBe('balanced');
    });

    it('should delegate streams and accumulate cost on success', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as unknown as AssistantMessageEventStream,
      );

      const delegateStream = (async function* () {
        yield { type: 'text_delta', delta: 'Answer part' };
        yield { type: 'done', message: { usage: { cost: { total: 0.0015 } } } };
      })();
      vi.mocked(streamSimple).mockReturnValue(delegateStream as unknown as ReturnType<typeof streamSimple>);

      const model = {
        id: 'balanced',
        api: 'router-api' as Api,
        provider: 'router',
      } as unknown as Model<Api>;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as unknown as Context;

      const providerStream = registeredProviderOptions!.streamSimple(
        model,
        context,
      );

      // Wait for async execution of stream handler
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockState.selectedProfile).toBe('balanced');
      expect(mockState.routerEnabled).toBe(true);
      expect(mockState.accumulatedCost).toBe(0.0015);
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should use the registered provider stream for custom APIs', async () => {
      const customStreamSimple = vi.fn().mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'custom answer' };
        })() as unknown as ReturnType<typeof streamSimple>,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'compat answer' };
        })() as unknown as ReturnType<typeof streamSimple>,
      );
      mockState.currentConfig.profiles.balanced.high = {
        model: 'custom/custom-model',
      };
      mockState.pinnedTierByProfile.balanced = 'high';
      mockState.currentModelRegistry!.find = (
        provider: string,
        modelId: string,
      ) => ({
        api: 'custom-api' as Api,
        provider,
        id: modelId,
        input: ['text'] as const,
      }) as unknown as Model<Api>;
      Object.assign(mockState.currentModelRegistry!, {
        getRegisteredProviderConfig: vi.fn().mockReturnValue({
          api: 'custom-api',
          streamSimple: customStreamSimple,
        }),
      });

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as unknown as AssistantMessageEventStream,
      );
      const model = {
        id: 'balanced',
        api: 'router-api' as Api,
        provider: 'router',
      } as unknown as Model<Api>;
      const context = {
        messages: [{ role: 'user', content: 'hello' }],
      } as unknown as Context;

      registeredProviderOptions!.streamSimple(model, context);

      await vi.waitFor(() => expect(customStreamSimple).toHaveBeenCalledOnce());
      expect(streamSimple).not.toHaveBeenCalled();
    });

    it('should try fallbacks if the primary model fails', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as unknown as AssistantMessageEventStream,
      );

      let callCount = 0;
      vi.mocked(streamSimple).mockImplementation(((model: Model<Api>) => {
        callCount++;
        if (model.id === 'gpt-4o-mini') {
          // Force fail for primary
          return (async function* () {
            throw new Error('primary failed');
          })() as unknown as ReturnType<typeof streamSimple>;
        }
        // Success for fallback
        return (async function* () {
          yield { type: 'text_delta', delta: 'fallback answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.0005 } } },
          };
        })() as unknown as ReturnType<typeof streamSimple>;
      }));

      // Force a medium tier routing decision
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = {
        id: 'balanced',
        api: 'router-api' as Api,
        provider: 'router',
      } as unknown as Model<Api>;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as unknown as Context;

      registeredProviderOptions!.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(callCount).toBe(2);
      expect(mockState.accumulatedCost).toBe(0.0005);
      expect(mockState.lastDecision!.isFallback).toBe(true);
    });

    it('should preserve previous Google model on Google thinking tool continuation', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as unknown as AssistantMessageEventStream,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'done' };
        })() as unknown as ReturnType<typeof streamSimple>,
      );

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
      ) => {
        return { provider, id: modelId, reasoning: true, input: ['text'] as const } as unknown as Model<Api>;
      };

      const model = {
        id: 'balanced',
        api: 'router-api' as Api,
        provider: 'router',
      } as unknown as Model<Api>;
      const context = {
        messages: [
          { role: 'user', content: 'initial', timestamp: Date.now() },
          {
            role: 'toolResult',
            toolCallId: 'c1',
            toolName: 't',
            content: 'tool output',
            isError: false,
            timestamp: Date.now(),
          },
        ],
      } as unknown as Context;

      registeredProviderOptions!.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // The decision should be updated to preserve the previous model
      expect(mockState.lastDecision!.targetModelId).toBe('gemini-2.5-pro');
      expect(mockState.lastDecision!.reasoning).toContain(
        'Preserved google/gemini-2.5-pro for a Google tool-result continuation',
      );
    });

    it('should force higher tier if current tier does not support image attachments', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as unknown as AssistantMessageEventStream,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'done' };
        })() as unknown as ReturnType<typeof streamSimple>,
      );

      // Define medium tier model and fallback without image support, high tier model with image support
      mockState.currentModelRegistry!.find = (
        provider: string,
        modelId: string,
      ) => {
        if (modelId === 'gpt-4o') {
          return { provider, id: modelId, input: ['text', 'image'] as const } as unknown as Model<Api>; // high does support image
        }
        return { provider, id: modelId, input: ['text'] as const } as unknown as Model<Api>; // medium and fallback gemini-1.5-flash don't support image
      };

      // Force a medium tier routing decision originally
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = {
        id: 'balanced',
        api: 'router-api' as Api,
        provider: 'router',
      } as unknown as Model<Api>;
      const context = {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image' as const,
                image: { mimeType: 'image/png', data: 'data' },
              },
            ],
            timestamp: Date.now(),
          },
        ],
      } as unknown as Context;

      registeredProviderOptions!.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // It should force switch to high tier because medium doesn't support images
      expect(mockState.lastDecision!.tier).toBe('high');
      expect(mockState.lastDecision!.reasoning).toContain(
        'Forced high tier because the originally routed medium tier does not support image attachments',
      );
    });

    it('should auto-truncate context if target limit is smaller than reported context window', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as unknown as AssistantMessageEventStream,
      );

      let truncatedContextPassed: Context | null = null;
      vi.mocked(streamSimple).mockImplementation(((model: Model<Api>, ctx: Context) => {
        truncatedContextPassed = ctx;
        return (async function* () {
          yield { type: 'text_delta', delta: 'done' };
        })() as unknown as ReturnType<typeof streamSimple>;
      }));

      // Medium tier model has resolvedContextWindow = 5000 in config.
      // But let's verify if reported max context window of router is larger (which is 10000 from high tier).
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = {
        id: 'balanced',
        api: 'router-api' as Api,
        provider: 'router',
        contextWindow: 10000,
      } as unknown as Model<Api>;

      // Let's create a large context that exceeds 5000 tokens (approx 15000 chars)
      const context = {
        systemPrompt: 'System prompt instructions',
        messages: [
          { role: 'user', content: 'a'.repeat(8000), timestamp: Date.now() },
          { role: 'user', content: 'b'.repeat(8000), timestamp: Date.now() },
          { role: 'user', content: 'c'.repeat(2000), timestamp: Date.now() }, // latest message
        ],
      } as unknown as Context;

      registeredProviderOptions!.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(truncatedContextPassed).toBeDefined();
      // Old messages should have been truncated to fit 5000 tokens limit (15000 chars approx)
      // The first message 'a'.repeat(8000) should have been shifted out.
      expect(truncatedContextPassed!.messages.length).toBeLessThan(
        context.messages.length,
      );
      expect(
        truncatedContextPassed!.messages[
          truncatedContextPassed!.messages.length - 1
        ].content,
      ).toBe('c'.repeat(2000));
    });

    it('should push error event when currentModelRegistry never becomes available', async () => {
      mockState.currentModelRegistry = undefined;
      mockState.registryTimeoutMs = 100; // Use short timeout for test
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as unknown as AssistantMessageEventStream,
      );

      const model = {
        id: 'balanced',
        api: 'router-api' as Api,
        provider: 'router',
      } as unknown as Model<Api>;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as unknown as Context;

      registeredProviderOptions!.streamSimple(model, context);

      await vi.waitFor(
        () => {
          const errorEvent = stream.events.find((e) => e.type === 'error');
          expect(errorEvent).toBeDefined();
          expect(errorEvent?.error?.errorMessage).toContain('timed out');
        },
        { timeout: 500 },
      );
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should wait and succeed when currentModelRegistry becomes available after a delay', async () => {
      mockState.currentModelRegistry = undefined;
      mockState.registryTimeoutMs = 500; // Allow enough time but not too long
      const mockRegistry = {
        find: (provider: string, modelId: string) => {
          if (provider === 'openai' || provider === 'google') {
            return { provider, id: modelId, input: ['text', 'image'] as const } as unknown as Model<Api>;
          }
          return undefined;
        },
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: 'test-key',
          headers: {},
        }),
      } as unknown as ExtensionContext['modelRegistry'];

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as unknown as AssistantMessageEventStream,
      );

      const delegateStream = (async function* () {
        yield { type: 'text_delta', delta: 'Answer' };
        yield { type: 'done', message: { usage: { cost: { total: 0.001 } } } };
      })();
      vi.mocked(streamSimple).mockReturnValue(delegateStream as unknown as ReturnType<typeof streamSimple>);

      const model = {
        id: 'balanced',
        api: 'router-api' as Api,
        provider: 'router',
      } as unknown as Model<Api>;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as unknown as Context;

      registeredProviderOptions!.streamSimple(model, context);

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
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as unknown as AssistantMessageEventStream,
      );

      const model = {
        id: 'nonexistent-profile',
        api: 'router-api' as Api,
        provider: 'router',
      } as unknown as Model<Api>;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as unknown as Context;

      registeredProviderOptions!.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const errorEvent = stream.events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.error?.errorMessage).toContain('Unknown router profile');
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should fall back when auth fails for primary model', async () => {
      let authCallCount = 0;
      mockState.currentModelRegistry!.getApiKeyAndHeaders = async (model: Model<Api>) => {
        authCallCount++;
        if (model.id === 'gpt-4o-mini') {
          return { ok: false, error: 'auth-error' };
        }
        return { ok: true, apiKey: 'fallback-key', headers: {} };
      };

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as unknown as AssistantMessageEventStream,
      );

      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'fallback answer' };
          yield { type: 'done', message: { usage: { cost: { total: 0.001 } } } };
        })() as unknown as ReturnType<typeof streamSimple>,
      );

      // Pin to medium so primary is gpt-4o-mini with fallback gemini-1.5-flash
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = {
        id: 'balanced',
        api: 'router-api' as Api,
        provider: 'router',
      } as unknown as Model<Api>;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as unknown as Context;

      registeredProviderOptions!.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(authCallCount).toBeGreaterThanOrEqual(2);
      expect(mockState.accumulatedCost).toBe(0.001);
    });

    it('should skip model not found in registry and try fallback', async () => {
      mockState.currentModelRegistry!.find = (provider: string, modelId: string) => {
        if (modelId === 'gpt-4o-mini') return undefined; // primary not found
        return { provider, id: modelId, input: ['text', 'image'] as const } as unknown as Model<Api>;
      };

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as unknown as AssistantMessageEventStream,
      );

      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'answer from fallback' };
          yield { type: 'done', message: { usage: { cost: { total: 0.002 } } } };
        })() as unknown as ReturnType<typeof streamSimple>,
      );

      // Pin to medium so primary is gpt-4o-mini with fallback gemini-1.5-flash
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = {
        id: 'balanced',
        api: 'router-api' as Api,
        provider: 'router',
      } as unknown as Model<Api>;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as unknown as Context;

      registeredProviderOptions!.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockState.accumulatedCost).toBe(0.002);
      expect(mockState.lastDecision!.isFallback).toBe(true);
    });

    it('should push error when all models in chain fail', async () => {
      vi.mocked(streamSimple).mockImplementation((() => {
        return (async function* () {
          throw new Error('model unavailable');
        })() as unknown as ReturnType<typeof streamSimple>;
      }));

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as unknown as AssistantMessageEventStream,
      );

      // Pin to medium to get fallback chain
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = {
        id: 'balanced',
        api: 'router-api' as Api,
        provider: 'router',
      } as unknown as Model<Api>;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as unknown as Context;

      registeredProviderOptions!.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const errorEvent = stream.events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.error?.errorMessage).toContain('model unavailable');
      expect(mockActions.persistState).toHaveBeenCalled();
    });
  });

  describe('waitForRegistry', () => {
    it('should return registry immediately if already available', async () => {
      const mockRegistry = { find: vi.fn() } as unknown as ExtensionContext['modelRegistry'];
      const state = { currentModelRegistry: mockRegistry };
      const result = await waitForRegistry(state, 1000);
      expect(result).toBe(mockRegistry);
    });

    it('should wait and return registry when it becomes available', async () => {
      const mockRegistry = { find: vi.fn() } as unknown as ExtensionContext['modelRegistry'];
      const state: { currentModelRegistry: ExtensionContext['modelRegistry'] | undefined } = {
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
      const result = await waitForRegistry(state, 200);
      expect(result).toBeUndefined();
    });
  });
});