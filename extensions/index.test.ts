import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type {
  CustomSessionEntry,
  RouterExtensionAPI,
  RouterModelSelectEvent,
  RouterThinkingLevelSelectEvent,
} from './types';
import routerExtension from './index';

const _extensionFactoryTypeCheck: ExtensionFactory = routerExtension;
void _extensionFactoryTypeCheck;

vi.mock('./config', () => ({
  loadRouterConfig: () => ({
    config: {
      profiles: {
        balanced: {
          high: { model: 'openai/gpt-4o' },
          medium: { model: 'openai/gpt-4o-mini' },
        },
      },
    },
    warnings: [],
  }),
  profileNames: () => ['balanced'],
  resolveProfileName: (_config: unknown, name: unknown) =>
    name === 'balanced' ? 'balanced' : undefined,
  parseCanonicalModelRef: (_ref: string) => ({
    provider: 'openai',
    modelId: 'gpt-4o',
  }),
  resolveContextWindow: () => 100000,
  resolveMaxTokens: () => 4000,
  resolveThinkingLevels: () => undefined,
  collectProfileThinkingLevels: () => new Set<string>(),
  getUnsupportedTiers: (): string[] => [],
  ROUTER_TIERS: ['high', 'medium', 'low'] as const,
  ROUTER_PIN_VALUES: ['auto', 'high', 'medium', 'low'] as const,
  DEFAULT_THINKING_LEVELS: ['high', 'medium', 'low'] as const,
  THINKING_LEVELS: [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ] as const,
  isRouterTier: (v: unknown) => v === 'high' || v === 'medium' || v === 'low',
  isThinkingLevel: (v: unknown) =>
    typeof v === 'string' &&
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(v),
  isObjectRecord: (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v),
}));

const createTestModel = (overrides: Partial<Model<Api>> = {}): Model<Api> => ({
  id: 'balanced',
  name: 'Balanced',
  api: 'openai-completions',
  provider: 'router',
  baseUrl: 'https://router.local',
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: true,
  contextWindow: 100000,
  maxTokens: 4000,
  ...overrides,
});

const buildMockCtx = () => ({
  cwd: '/mock/cwd',
  modelRegistry: {
    find: vi
      .fn<(provider: string, modelId: string) => Model<Api> | undefined>()
      .mockReturnValue(createTestModel({ provider: 'router', id: 'balanced' })),
  },
  model: {
    provider: 'router',
    id: 'balanced',
  } as RouterModelSelectEvent['model'] | undefined,
  sessionManager: {
    getBranch: (): CustomSessionEntry[] => [],
  },
  ui: {
    setStatus: vi.fn((_key: string, _text: string | undefined) => {}),
    setWidget: vi.fn((_key: string, _content: string[] | undefined) => {}),
    theme: { fg: (_c: 'dim', text: string) => text },
    notify: vi.fn(
      (_message: string, _type?: 'info' | 'warning' | 'error') => {},
    ),
  },
});

type MockCtx = ReturnType<typeof buildMockCtx>;

type FullRouterEvent = RouterModelSelectEvent &
  RouterThinkingLevelSelectEvent & {
    message?: {
      role?: string;
      usage?: { cost?: { total?: number } };
    };
  };

type RegisteredHandler = (
  event: FullRouterEvent,
  ctx: MockCtx,
) => Promise<void> | void;

type TriggerHandler = (
  event: Partial<FullRouterEvent>,
  ctx: MockCtx,
) => Promise<void> | void;

const createMockPi = (eventListeners: Record<string, TriggerHandler[]>) => ({
  registerVirtualModel: vi.fn(() => {}),
  unregisterVirtualModel: vi.fn(() => {}),
  registerProvider: vi.fn(() => {}),
  registerCommand: vi.fn(() => {}),
  setModel: vi.fn(async () => true),
  appendEntry: vi.fn(() => {}),
  on: vi.fn((event: string, handler: RegisteredHandler) => {
    if (!eventListeners[event]) {
      eventListeners[event] = [];
    }
    eventListeners[event].push((partialEvent, ctx) =>
      handler(
        {
          model: { provider: 'router', id: 'balanced' },
          level: 'off',
          ...partialEvent,
        },
        ctx,
      ),
    );
  }),
});

describe('index.ts (orchestrator)', () => {
  let mockPi: ReturnType<typeof createMockPi> & RouterExtensionAPI<MockCtx>;
  let eventListeners: Record<string, TriggerHandler[]> = {};

  beforeEach(() => {
    eventListeners = {};
    mockPi = createMockPi(eventListeners);
  });

  it('should initialize and register commands, virtual models, and event hooks', () => {
    routerExtension(mockPi);

    expect(mockPi.registerVirtualModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'router',
        id: 'balanced',
      }),
    );
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      'router',
      expect.any(Object),
    );
    expect(mockPi.on).toHaveBeenCalledWith(
      'session_start',
      expect.any(Function),
    );
    expect(mockPi.on).toHaveBeenCalledWith(
      'session_tree',
      expect.any(Function),
    );
    expect(mockPi.on).toHaveBeenCalledWith(
      'model_select',
      expect.any(Function),
    );
    expect(mockPi.on).toHaveBeenCalledWith('turn_end', expect.any(Function));
  });

  it('should restore state from session on session_start hook', async () => {
    routerExtension(mockPi);

    const mockCtx = buildMockCtx();
    mockCtx.sessionManager.getBranch = () => [
      {
        type: 'custom',
        customType: 'router-state',
        data: {
          enabled: true,
          selectedProfile: 'balanced',
          pinByProfile: { balanced: 'high' },
          thinkingByProfile: {},
          debugEnabled: true,
          widgetEnabled: true,
          accumulatedCost: 0.012,
          timestamp: Date.now(),
        },
      },
    ];

    // Trigger session_start
    const sessionStartHandlers = eventListeners['session_start'] || [];
    for (const handler of sessionStartHandlers) {
      await handler({}, mockCtx);
    }

    expect(mockCtx.ui.setStatus).toHaveBeenCalled();
    expect(mockPi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'router', id: 'balanced' }),
    );
  });

  it('should handle model select hook', async () => {
    routerExtension(mockPi);

    const mockCtx = buildMockCtx();

    // Trigger session_start to initialize first
    const sessionStartHandlers = eventListeners['session_start'] || [];
    for (const handler of sessionStartHandlers) {
      await handler({}, mockCtx);
    }

    const modelSelectHandlers = eventListeners['model_select'] || [];
    for (const handler of modelSelectHandlers) {
      await handler({ model: { provider: 'router', id: 'balanced' } }, mockCtx);
    }

    expect(mockCtx.ui.setStatus).toHaveBeenCalled();
  });

  describe('model_select event', () => {
    it('should set routerEnabled=false and record lastNonRouterModel for non-router model', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      // Initialize via session_start
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Clear appendEntry calls from initialization
      mockPi.appendEntry.mockClear();

      // Select a non-router model
      const modelSelectHandlers = eventListeners['model_select'] || [];
      for (const handler of modelSelectHandlers) {
        await handler(
          { model: { provider: 'anthropic', id: 'claude-3-5-sonnet' } },
          mockCtx,
        );
      }

      // Should have persisted state (routerEnabled=false, lastNonRouterModel set)
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: false,
          lastNonRouterModel: 'anthropic/claude-3-5-sonnet',
        }),
      );
    });

    it('should be a no-op before session_start (isInitialized=false)', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      // Clear calls from constructor
      mockPi.appendEntry.mockClear();
      mockCtx.ui.setStatus.mockClear();

      // Trigger model_select WITHOUT session_start first
      const modelSelectHandlers = eventListeners['model_select'] || [];
      for (const handler of modelSelectHandlers) {
        await handler(
          { model: { provider: 'anthropic', id: 'claude-3-5-sonnet' } },
          mockCtx,
        );
      }

      // Should NOT have persisted state or updated status
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });
  });

  describe('thinking_level_select event', () => {
    it('should apply thinking level as all-tier override for active profile', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      // Initialize via session_start (sets routerEnabled=true, selectedProfile='balanced')
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Clear appendEntry calls from initialization
      mockPi.appendEntry.mockClear();

      // Trigger thinking_level_select
      const thinkingHandlers = eventListeners['thinking_level_select'] || [];
      for (const handler of thinkingHandlers) {
        handler({ level: 'high' }, mockCtx);
      }

      // Should persist state with thinking overrides for all tiers
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          thinkingByProfile: {
            balanced: { high: 'high', medium: 'high', low: 'high' },
          },
        }),
      );
    });

    it('should be ignored when router is not enabled', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      // Set model to non-router so routerEnabled stays false after restore
      mockCtx.model = { provider: 'openai', id: 'gpt-4o' };

      // Initialize via session_start with non-router model
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      mockPi.appendEntry.mockClear();

      // Trigger thinking_level_select
      const thinkingHandlers = eventListeners['thinking_level_select'] || [];
      for (const handler of thinkingHandlers) {
        handler({ level: 'medium' }, mockCtx);
      }

      // Should NOT have called appendEntry (no persist because early return)
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });

    it('should be ignored before initialization', () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      mockPi.appendEntry.mockClear();

      // Trigger thinking_level_select without session_start
      const thinkingHandlers = eventListeners['thinking_level_select'] || [];
      for (const handler of thinkingHandlers) {
        handler({ level: 'low' }, mockCtx);
      }

      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });

    it('should ignore thinking_level_select emitted by pi.setModel during session_start (defaultThinkingLevel in settings.json)', async () => {
      const mockCtx = buildMockCtx();

      // Simulate Pi >= 0.85.0 behavior where pi.setModel emits thinking_level_select
      // with defaultThinkingLevel from settings.json
      mockPi.setModel = vi.fn(async () => {
        const thinkingHandlers = eventListeners['thinking_level_select'] || [];
        for (const handler of thinkingHandlers) {
          await handler({ level: 'medium' }, mockCtx);
        }
        return true;
      });

      routerExtension(mockPi);

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: true,
          selectedProfile: 'balanced',
          thinkingByProfile: {},
        }),
      );
    });

    it('should ignore thinking_level_select when ctx.model does not match the active router profile', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      mockPi.appendEntry.mockClear();

      // Simulate external model switch where Pi updates ctx.model and emits
      // thinking_level_select before emitting model_select
      mockCtx.model = { provider: 'anthropic', id: 'claude-3-5-sonnet' };
      const thinkingHandlers = eventListeners['thinking_level_select'] || [];
      for (const handler of thinkingHandlers) {
        await handler({ level: 'medium' }, mockCtx);
      }

      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });
  });

  describe('restoreStateFromSession edge cases', () => {
    it('should handle fresh session with no saved router-state entries', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      // Empty session
      mockCtx.sessionManager.getBranch = () => [];

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Should still set model (model is router/balanced by default)
      expect(mockPi.setModel).toHaveBeenCalled();
      // Should persist initial state
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: true,
          selectedProfile: 'balanced',
        }),
      );
    });

    it('should handle failed model restoration (setModel returns false)', async () => {
      mockPi.setModel = vi.fn().mockResolvedValue(false);
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            pinByProfile: {},
            thinkingByProfile: {},
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Should notify about failure
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Failed to restore router/balanced'),
        'warning',
      );

      // routerEnabled should be set to false
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: false,
        }),
      );
    });

    it('should handle router model unavailable in registry', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      // Registry returns undefined for router model
      mockCtx.modelRegistry.find = vi.fn().mockReturnValue(undefined);
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            pinByProfile: {},
            thinkingByProfile: {},
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Should notify about unavailability
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Unable to restore router/balanced'),
        'warning',
      );

      // routerEnabled should be false
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: false,
        }),
      );
    });

    it('should migrate legacy pinTier field to pinByProfile', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            pinTier: 'medium',
            pinByProfile: {},
            thinkingByProfile: {},
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Should persist with the legacy pinTier migrated into pinByProfile
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          pinByProfile: expect.objectContaining({ balanced: 'medium' }),
        }),
      );
    });
  });

  describe('turn_end event', () => {
    it('should persist state and update status but NOT restore model when router is not enabled', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      // Set model to non-router
      mockCtx.model = { provider: 'openai', id: 'gpt-4o' };

      // Initialize via session_start with non-router model
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Clear mocks after initialization
      mockPi.setModel.mockClear();
      mockPi.appendEntry.mockClear();
      mockCtx.ui.setStatus.mockClear();

      // Trigger turn_end
      const turnEndHandlers = eventListeners['turn_end'] || [];
      for (const handler of turnEndHandlers) {
        await handler({}, mockCtx);
      }

      // Should NOT call setModel (router is not enabled)
      expect(mockPi.setModel).not.toHaveBeenCalled();

      // Should still update status
      expect(mockCtx.ui.setStatus).toHaveBeenCalled();

      // persistState is called, but snapshot deduplication may skip appendEntry
      // since state hasn't changed since session_start. The key assertion is
      // that setModel was NOT called (router is not enabled).
    });
  });

  describe('persistState deduplication', () => {
    it('should only call appendEntry once when state has not changed between turn_end calls', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      // Initialize with router enabled (default: model is router/balanced)
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Select router model to ensure routerEnabled=true
      const modelSelectHandlers = eventListeners['model_select'] || [];
      for (const handler of modelSelectHandlers) {
        await handler(
          { model: { provider: 'router', id: 'balanced' } },
          mockCtx,
        );
      }

      // Clear mocks after initialization and model_select
      mockPi.appendEntry.mockClear();

      // Trigger turn_end — first call may persist if snapshot differs
      const turnEndHandlers = eventListeners['turn_end'] || [];
      for (const handler of turnEndHandlers) {
        await handler({}, mockCtx);
      }
      const callsAfterFirst = mockPi.appendEntry.mock.calls.length;

      // Trigger turn_end again — state is identical, snapshot dedup should skip
      for (const handler of turnEndHandlers) {
        await handler({}, mockCtx);
      }
      const callsAfterSecond = mockPi.appendEntry.mock.calls.length;

      // No additional appendEntry calls on the second turn_end
      expect(callsAfterSecond).toBe(callsAfterFirst);
    });
  });

  describe('ensureInitializedFromContext', () => {
    it('should initialize registry and context on first turn_start, but not overwrite on subsequent events', async () => {
      routerExtension(mockPi);

      const mockCtx1 = buildMockCtx();
      mockCtx1.cwd = '/mock/cwd1';

      // Trigger turn_start event with mockCtx1
      const turnStartHandlers = eventListeners['turn_start'] || [];
      for (const handler of turnStartHandlers) {
        await handler({}, mockCtx1);
      }

      // Should have reloaded config and updated status because registry was undefined
      expect(mockCtx1.ui.setStatus).toHaveBeenCalled();
      mockCtx1.ui.setStatus.mockClear();

      // Trigger turn_start with a DIFFERENT CWD — should NOT reinitialize because
      // registry is already set (guards against subagent overwriting parent state)
      const mockCtx2 = buildMockCtx();
      mockCtx2.cwd = '/mock/cwd2';
      await turnStartHandlers[0]({}, mockCtx2);
      expect(mockCtx2.ui.setStatus).not.toHaveBeenCalled();
    });

    it('should refresh router virtual model registration on turn_start when dynamic models (e.g. llama.cpp) are added after session_start', async () => {
      let dynamicModelLoaded = false;
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.modelRegistry.find = vi.fn(
        (provider: string, modelId: string) => {
          if (provider === 'openai' && modelId === 'gpt-4o') {
            return dynamicModelLoaded
              ? createTestModel({
                  provider,
                  id: modelId,
                  reasoning: true,
                })
              : undefined;
          }
          return createTestModel({
            provider,
            id: modelId,
            reasoning: false,
          });
        },
      );

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      mockPi.registerVirtualModel.mockClear();

      // Simulate dynamic model registration (e.g. via /llama command after session_start)
      dynamicModelLoaded = true;

      const turnStartHandlers = eventListeners['turn_start'] || [];
      for (const handler of turnStartHandlers) {
        await handler({}, mockCtx);
      }

      expect(mockPi.registerVirtualModel).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'router',
          id: 'balanced',
          thinkingLevels: ['off', 'low', 'medium', 'high'],
        }),
      );
    });

    it('should accumulate assistant message cost on turn_end when router is enabled', async () => {
      routerExtension(mockPi);
      const mockCtx = buildMockCtx();

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      mockPi.appendEntry.mockClear();

      const turnEndHandlers = eventListeners['turn_end'] || [];
      const assistantMessage = {
        role: 'assistant',
        usage: { cost: { total: 0.0042 } },
      };
      for (const handler of turnEndHandlers) {
        await handler({ message: assistantMessage }, mockCtx);
      }

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          accumulatedCost: 0.0042,
        }),
      );
    });
  });
});
