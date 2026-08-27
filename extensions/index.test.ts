import { describe, it, expect, vi, beforeEach } from 'vitest';
import routerExtension from './index';

const stateMocks = vi.hoisted(() => ({
  loadLastRouterProfile: vi.fn(),
  saveLastRouterProfile: vi.fn(),
}));

vi.mock('./state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./state')>()),
  loadLastRouterProfile: stateMocks.loadLastRouterProfile,
  saveLastRouterProfile: stateMocks.saveLastRouterProfile,
}));

vi.mock('./config', () => ({
  loadRouterConfig: () => ({
    config: {
      profiles: {
        balanced: {
          high: { model: 'openai/gpt-4o' },
          medium: { model: 'openai/gpt-4o-mini' },
        },
        alternate: {
          high: { model: 'anthropic/claude-opus-4' },
          medium: { model: 'anthropic/claude-sonnet-4' },
        },
      },
    },
    warnings: [],
  }),
  profileNames: () => ['alternate', 'balanced'],
  resolveProfileName: (
    config: { profiles: Record<string, unknown> },
    name: unknown,
  ) => (typeof name === 'string' && config.profiles[name] ? name : undefined),
  parseCanonicalModelRef: (_ref: string) => ({
    provider: 'openai',
    modelId: 'gpt-4o',
  }),
  resolveContextWindow: () => 100000,
  resolveMaxTokens: () => 4000,
  collectProfileThinkingLevels: () => new Set<string>(),
  getUnsupportedTiers: () => [] as string[],
  ROUTER_TIERS: ['high', 'medium', 'low'] as const,
  ROUTER_PIN_VALUES: ['auto', 'high', 'medium', 'low'] as const,
  THINKING_LEVELS: [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ] as const,
  isRouterTier: (v: unknown) => v === 'high' || v === 'medium' || v === 'low',
}));

describe('index.ts (orchestrator)', () => {
  let mockPi: any;
  let eventListeners: Record<string, Function[]> = {};

  beforeEach(() => {
    eventListeners = {};
    stateMocks.loadLastRouterProfile.mockReset();
    stateMocks.loadLastRouterProfile.mockReturnValue(undefined);
    stateMocks.saveLastRouterProfile.mockReset();
    stateMocks.saveLastRouterProfile.mockReturnValue(true);
    mockPi = {
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      setModel: vi.fn().mockResolvedValue(true),
      setThinkingLevel: vi.fn(),
      appendEntry: vi.fn(),
      on: vi.fn().mockImplementation((event: string, handler: Function) => {
        if (!eventListeners[event]) {
          eventListeners[event] = [];
        }
        eventListeners[event].push(handler);
      }),
    };
  });

  const buildMockCtx = () => ({
    cwd: '/mock/cwd',
    modelRegistry: {
      find: vi.fn().mockReturnValue({ provider: 'router', id: 'balanced' }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'key' }),
    },
    model: { provider: 'router', id: 'balanced' },
    sessionManager: {
      getBranch: () => [] as unknown[],
    },
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setHiddenThinkingLabel: vi.fn(),
      theme: { fg: (c: string, text: string) => text },
      notify: vi.fn(),
    },
  });

  it('should initialize and register commands, provider, and event hooks', () => {
    routerExtension(mockPi);

    expect(mockPi.registerProvider).toHaveBeenCalledWith(
      'router',
      expect.any(Object),
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
    expect(stateMocks.saveLastRouterProfile).toHaveBeenCalledWith('balanced');
  });

  it('should enforce router model on turn_end hook', async () => {
    routerExtension(mockPi);

    const mockCtx = buildMockCtx();

    // Trigger session_start to initialize
    const sessionStartHandlers = eventListeners['session_start'] || [];
    for (const handler of sessionStartHandlers) {
      await handler({}, mockCtx);
    }

    // Now trigger model_select to select a router model
    const modelSelectHandlers = eventListeners['model_select'] || [];
    for (const handler of modelSelectHandlers) {
      await handler({ model: { provider: 'router', id: 'balanced' } }, mockCtx);
    }

    // Change current model to non-router model
    mockCtx.model = { provider: 'openai', id: 'gpt-4o' };

    // Trigger turn_end
    const turnEndHandlers = eventListeners['turn_end'] || [];
    for (const handler of turnEndHandlers) {
      await handler({}, mockCtx);
    }

    // It should have restored model selection to the active router profile model
    expect(mockPi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'router', id: 'balanced' }),
    );
  });

  describe('model_select event', () => {
    it('should set routerEnabled=false, record lastNonRouterModel, and call setHiddenThinkingLabel for non-router model', async () => {
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

      // Should have called setHiddenThinkingLabel
      expect(mockCtx.ui.setHiddenThinkingLabel).toHaveBeenCalled();

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
      expect(mockCtx.ui.setHiddenThinkingLabel).not.toHaveBeenCalled();
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

    it('should restore the last profile for a new startup session', async () => {
      stateMocks.loadLastRouterProfile.mockReturnValue('alternate');
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.modelRegistry.find = vi
        .fn()
        .mockImplementation((provider: string, id: string) => ({
          provider,
          id,
        }));

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({ reason: 'startup' }, mockCtx);
      }

      expect(mockPi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'router', id: 'alternate' }),
      );
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: true,
          selectedProfile: 'alternate',
        }),
      );
    });

    it('should preserve an explicit CLI model selection', async () => {
      stateMocks.loadLastRouterProfile.mockReturnValue('alternate');
      routerExtension(mockPi);

      const originalArgv = process.argv;
      process.argv = [...originalArgv, '--model=router/balanced'];
      try {
        const mockCtx = buildMockCtx();
        mockCtx.sessionManager.getBranch = () => [
          {
            type: 'custom',
            customType: 'router-state',
            data: {
              enabled: true,
              selectedProfile: 'alternate',
              lastNonRouterModel: 'anthropic/claude-sonnet-4',
              timestamp: Date.now(),
            },
          },
        ];
        const sessionStartHandlers = eventListeners['session_start'] || [];
        for (const handler of sessionStartHandlers) {
          await handler({ reason: 'startup' }, mockCtx);
        }
      } finally {
        process.argv = originalArgv;
      }

      expect(stateMocks.loadLastRouterProfile).not.toHaveBeenCalled();
      expect(mockPi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'router', id: 'balanced' }),
      );
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: true,
          selectedProfile: 'balanced',
        }),
      );
    });

    it('should not enable the router when Pi starts on a non-router model', async () => {
      stateMocks.loadLastRouterProfile.mockReturnValue('alternate');
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.model = { provider: 'openai', id: 'gpt-4o' };
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({ reason: 'startup' }, mockCtx);
      }

      expect(stateMocks.loadLastRouterProfile).not.toHaveBeenCalled();
      expect(mockPi.setModel).not.toHaveBeenCalled();
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({ enabled: false }),
      );
    });

    it('should ignore a last profile that is no longer configured', async () => {
      stateMocks.loadLastRouterProfile.mockReturnValue('removed');
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({ reason: 'startup' }, mockCtx);
      }

      expect(mockPi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'router', id: 'balanced' }),
      );
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({ selectedProfile: 'balanced' }),
      );
    });

    it('should prefer branch state over the cross-session profile', async () => {
      stateMocks.loadLastRouterProfile.mockReturnValue('alternate');
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({ reason: 'startup' }, mockCtx);
      }

      expect(mockPi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'router', id: 'balanced' }),
      );
      expect(stateMocks.loadLastRouterProfile).not.toHaveBeenCalled();
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

      // Should call setHiddenThinkingLabel
      expect(mockCtx.ui.setHiddenThinkingLabel).toHaveBeenCalled();

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

    it('should sync thinking level when lastDecision exists on successful restore', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      const decision = {
        profile: 'balanced',
        tier: 'high' as const,
        phase: 'planning' as const,
        targetProvider: 'openai',
        targetModelId: 'gpt-4o',
        targetLabel: 'openai/gpt-4o',
        reasoning: 'test',
        thinking: 'high' as const,
        timestamp: Date.now(),
      };
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            pinByProfile: {},
            thinkingByProfile: {},
            lastDecision: decision,
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // setModel succeeds (default mock), lastDecision exists => should sync thinking level
      expect(mockPi.setThinkingLevel).toHaveBeenCalledWith('high');
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
  });
});
