import { describe, it, expect, vi } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { registerCommands } from './commands';
import type {
  RouterConfig,
  RoutingDecision,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RouterCommandContext,
} from './types';

interface RegisteredRouterCommand {
  description?: string;
  getArgumentCompletions?: (
    prefix: string,
  ) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler: (args: string, ctx: RouterCommandContext) => Promise<void>;
}

const createTestModel = (provider: string, id: string): Model<Api> => ({
  id,
  name: id,
  api: 'openai-completions',
  provider,
  baseUrl: 'https://api.openai.com/v1',
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 4096,
});

describe('commands.ts', () => {
  const buildMockPi = () => {
    let registeredCommand: RegisteredRouterCommand | null = null;
    return {
      registerCommand: (name: string, cmd: RegisteredRouterCommand) => {
        if (name === 'router') {
          registeredCommand = cmd;
        }
      },
      setModel: vi
        .fn<(model: Model<Api>) => Promise<boolean>>()
        .mockResolvedValue(true),
      getRegisteredCommand: () => {
        if (!registeredCommand || !registeredCommand.getArgumentCompletions) {
          throw new Error('Command router was not registered');
        }
        return {
          ...registeredCommand,
          getArgumentCompletions: (
            prefix: string,
          ): AutocompleteItem[] | null => {
            const res = registeredCommand!.getArgumentCompletions!(prefix);
            return res instanceof Promise ? null : res;
          },
        };
      },
    };
  };

  const buildMockCtx = () => ({
    ui: {
      notify:
        vi.fn<(message: string, type?: 'info' | 'warning' | 'error') => void>(),
      setStatus: vi.fn<(key: string, text: string | undefined) => void>(),
      setWidget: vi.fn<(key: string, content: string[] | undefined) => void>(),
    },
    modelRegistry: {
      find: vi
        .fn<(provider: string, modelId: string) => Model<Api> | undefined>()
        .mockImplementation((provider: string, modelId: string) => {
          if (provider === 'router' || provider === 'openai') {
            return createTestModel(provider, modelId);
          }
          return undefined;
        }),
    },
    model: { provider: 'router', id: 'balanced' },
  });

  const buildDefaultState = () => {
    const config: RouterConfig = {
      phaseBias: 0.5,
      profiles: {
        balanced: {
          high: { model: 'openai/gpt-4o' },
          medium: { model: 'openai/gpt-4o-mini' },
        },
        cheap: {
          low: { model: 'openai/gpt-4o-micro' },
        },
      },
    };

    const lastDecision: RoutingDecision = {
      profile: 'balanced',
      tier: 'medium',
      phase: 'implementation',
      targetProvider: 'openai',
      targetModelId: 'gpt-4o-mini',
      targetLabel: 'openai/gpt-4o-mini',
      reasoning: 'Default reasoning',
      thinking: 'medium',
      timestamp: Date.now(),
    };

    return {
      currentConfig: config,
      routerEnabled: true,
      selectedProfile: 'balanced' as string | undefined,
      pinnedTierByProfile: {} as RouterPinByProfile,
      thinkingByProfile: {} as RouterThinkingByProfile,
      lastDecision: lastDecision as RoutingDecision | undefined,
      lastNonRouterModel: 'openai/gpt-4o' as string | undefined,
      accumulatedCost: 0.05,
      debugEnabled: false,
      widgetEnabled: false,
      debugHistory: [lastDecision],
      lastConfigWarnings: [] as string[],
    };
  };

  const buildMockActions = () => ({
    persistState: vi.fn(),
    updateStatus: vi.fn(),
    reloadConfig: vi.fn(),
    ensureValidActiveRouterProfile: vi.fn(),
    switchToRouterProfile: vi.fn().mockResolvedValue(true),
  });

  describe('Registration & Subcommand Completion', () => {
    it('should register router command', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi, state, actions);
      expect(pi.getRegisteredCommand()).toBeDefined();
    });

    it('should autocomplete subcommands', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      const completions = cmd.getArgumentCompletions('');
      expect(completions).toBeDefined();
      const names = completions!.map((c) => c.value);
      expect(names).toContain('status');
      expect(names).toContain('profile');
      expect(names).toContain('pin');
    });

    it('should autocomplete profile names', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      const completions = cmd.getArgumentCompletions('profile ');
      expect(completions).toBeDefined();
      const values = completions!.map((c) => c.value);
      expect(values).toContain('profile balanced');
      expect(values).toContain('profile cheap');
    });

    it('should autocomplete pin arguments', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      const completions = cmd.getArgumentCompletions('pin ');
      expect(completions).toBeDefined();
      const values = completions!.map((c) => c.value);
      expect(values).toContain('pin auto');
      expect(values).toContain('pin high');
      expect(values).not.toContain('pin balanced');
    });
  });

  describe('Handler Subcommands', () => {
    it('should handle /router status', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('status', ctx);
      expect(ctx.ui.notify).toHaveBeenCalled();
      const notifyMessage = ctx.ui.notify.mock.calls[0][0];
      expect(notifyMessage).toContain('Model Router Status:');
      expect(notifyMessage).toContain('Selected profile: balanced');
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('should handle /router profile switch', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('profile cheap', ctx);
      expect(actions.switchToRouterProfile).toHaveBeenCalledWith('cheap', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Switched to router profile'),
        'info',
      );
    });

    it('should handle /router pin', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('pin high', ctx);
      expect(state.pinnedTierByProfile.balanced).toBe('high');
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Router pinned to high',
        'info',
      );

      // Clear pin
      await cmd.handler('pin auto', ctx);
      expect(state.pinnedTierByProfile.balanced).toBeUndefined();
    });

    it('should handle /router thinking', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('thinking high xhigh', ctx);
      expect(state.thinkingByProfile.balanced?.high).toBe('xhigh');
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('should handle /router disable', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('disable', ctx);
      expect(pi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          id: 'gpt-4o',
        }),
      );
      expect(state.routerEnabled).toBe(false);
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('should handle /router fix', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('fix low', ctx);
      expect(state.pinnedTierByProfile.balanced).toBe('low');
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('should handle /router widget toggles', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('widget on', ctx);
      expect(state.widgetEnabled).toBe(true);

      await cmd.handler('widget off', ctx);
      expect(state.widgetEnabled).toBe(false);
    });

    it('should handle /router debug history control', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('debug show', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Recent Routing Decisions'),
        'info',
      );

      await cmd.handler('debug clear', ctx);
      expect(state.debugHistory.length).toBe(0);
    });

    it('should handle /router reload config', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('reload', ctx);
      expect(actions.reloadConfig).toHaveBeenCalledWith(ctx, {
        preserveDebug: true,
      });
      expect(actions.ensureValidActiveRouterProfile).toHaveBeenCalledWith(ctx);
    });
  });

  describe('handleStatus edge cases', () => {
    it('should show error when status has extra args', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('status extra', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router status (no arguments)',
        'error',
      );
    });

    it('should handle status without lastDecision', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.lastDecision = undefined;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('status', ctx);
      const notifyMessage = ctx.ui.notify.mock.calls[0][0];
      expect(notifyMessage).toContain('Model Router Status:');
      expect(notifyMessage).not.toContain('Last routed tier:');
    });

    it('should show config warnings in status', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.lastConfigWarnings = ['Warning 1', 'Warning 2'];
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('status', ctx);
      const notifyMessage = ctx.ui.notify.mock.calls[0][0];
      expect(notifyMessage).toContain('⚠️ Configuration Warnings:');
      expect(notifyMessage).toContain('Warning 1');
      expect(notifyMessage).toContain('Warning 2');
    });

    it('should show maxSessionBudget in status', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.currentConfig.maxSessionBudget = 10.0;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('status', ctx);
      const notifyMessage = ctx.ui.notify.mock.calls[0][0];
      expect(notifyMessage).toContain('$10.00');
    });
  });

  describe('handleProfile edge cases', () => {
    it('should show current profile when no argument given', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('profile', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Current profile: balanced'),
        'info',
      );
    });

    it('should show error when profile has too many arguments', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('profile one two', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router profile [name]',
        'error',
      );
    });

    it('should not notify on profile switch failure', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      actions.switchToRouterProfile.mockResolvedValue(false);
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('profile nonexistent', ctx);
      expect(actions.switchToRouterProfile).toHaveBeenCalledWith(
        'nonexistent',
        ctx,
      );
      // When switchToRouterProfile returns false, no success notification
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining('Switched to router profile'),
        'info',
      );
    });
  });

  describe('handlePin edge cases', () => {
    it('should show error when no active profile', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.selectedProfile = undefined;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('pin high', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'No router profile is active. Select a router model first.',
        'error',
      );
    });

    it('should show current pin when no arguments', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('pin', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Pinned tier: auto'),
        'info',
      );
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('should show error when pin has too many arguments', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('pin high extra', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router pin <high|medium|low|auto>',
        'error',
      );
    });

    it('should show error when pin value is invalid', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('pin invalid', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Invalid router pin: invalid'),
        'error',
      );
    });
  });

  describe('handleThinking branches', () => {
    it('should show error when no active profile', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.selectedProfile = undefined;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('thinking high', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'No router profile is active. Select a router model first.',
        'error',
      );
    });

    it('should show current thinking when no arguments', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('thinking', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Thinking overrides:'),
        'info',
      );
    });

    it('should show error with too many arguments', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('thinking high medium low', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Too many arguments for /router thinking.',
        'error',
      );
    });

    it('should show error with invalid tier', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('thinking badtier high', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Invalid tier: badtier'),
        'error',
      );
    });

    it('should show error with invalid level', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('thinking badlevel', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Invalid thinking level: badlevel'),
        'error',
      );
    });

    it('should apply auto to all tiers and clear overrides', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.thinkingByProfile.balanced = { high: 'xhigh', medium: 'medium' };
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('thinking auto', ctx);
      // All tier overrides should be cleared, and the profile entry deleted
      expect(state.thinkingByProfile.balanced).toBeUndefined();
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('should apply thinking level to specific tier', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('thinking low minimal', ctx);
      expect(state.thinkingByProfile.balanced?.low).toBe('minimal');
      expect(actions.persistState).toHaveBeenCalled();
    });

    it('should clear specific tier with auto', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.thinkingByProfile.balanced = { high: 'xhigh' };
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('thinking high auto', ctx);
      // The profile entry should be cleaned up since it's empty
      expect(state.thinkingByProfile.balanced).toBeUndefined();
      expect(actions.persistState).toHaveBeenCalled();
    });

    it('should warn about unsupported tiers', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      // Set up profile with resolvedThinkingLevels that exclude 'xhigh'
      state.currentConfig.profiles.balanced = {
        high: {
          model: 'openai/gpt-4o',
          resolvedThinkingLevels: ['high', 'medium', 'low'],
        },
        medium: {
          model: 'openai/gpt-4o-mini',
          resolvedThinkingLevels: ['high', 'medium', 'low'],
        },
      };
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('thinking xhigh', ctx);
      // Should warn that tiers don't support xhigh
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("may not support 'xhigh'"),
        'warning',
      );
    });

    it('should not warn for off level', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.currentConfig.profiles.balanced = {
        high: {
          model: 'openai/gpt-4o',
          resolvedThinkingLevels: ['high', 'medium'],
        },
      };
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('thinking off', ctx);
      // Should NOT warn for 'off'
      const warnCalls = ctx.ui.notify.mock.calls.filter(
        (c: unknown[]) => c[1] === 'warning',
      );
      expect(warnCalls.length).toBe(0);
    });

    it('should accept "all" as explicit tier arg', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('thinking all high', ctx);
      expect(state.thinkingByProfile.balanced?.high).toBe('high');
      expect(state.thinkingByProfile.balanced?.medium).toBe('high');
      expect(state.thinkingByProfile.balanced?.low).toBe('high');
      expect(actions.persistState).toHaveBeenCalled();
    });
  });

  describe('handleDisable edge cases', () => {
    it('should show error with extra args', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('disable extra', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router disable (no arguments)',
        'error',
      );
    });

    it('should warn when no lastNonRouterModel', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.lastNonRouterModel = undefined;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('disable', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('No previous non-router model recorded'),
        'warning',
      );
    });

    it('should show error when model not found in registry', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.lastNonRouterModel = 'unknown/model-x';
      const actions = buildMockActions();
      const ctx = buildMockCtx();
      ctx.modelRegistry.find.mockReturnValue(undefined);

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('disable', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Recorded non-router model is unavailable'),
        'error',
      );
    });

    it('should show error when setModel fails', async () => {
      const pi = buildMockPi();
      pi.setModel.mockResolvedValue(false);
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('disable', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Failed to switch to'),
        'error',
      );
      // State should NOT be changed on failure
      expect(state.routerEnabled).toBe(true);
    });
  });

  describe('handleFix edge cases', () => {
    it('should show error with wrong number of args', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('fix', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router fix <high|medium|low>',
        'error',
      );
    });

    it('should show error with too many args', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('fix high extra', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router fix <high|medium|low>',
        'error',
      );
    });

    it('should show error with invalid tier', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('fix badtier', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router fix <high|medium|low>',
        'error',
      );
    });

    it('should warn when no last decision', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.lastDecision = undefined;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('fix high', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'No recent routing decision to fix.',
        'warning',
      );
    });
  });

  describe('handleWidget edge cases', () => {
    it('should show error with too many args', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('widget on extra', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router widget <on|off|toggle>',
        'error',
      );
    });

    it('should toggle widget when no arg given', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.widgetEnabled = false;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('widget', ctx);
      expect(state.widgetEnabled).toBe(true);
      expect(actions.persistState).toHaveBeenCalled();

      await cmd.handler('widget', ctx);
      expect(state.widgetEnabled).toBe(false);
    });
  });

  describe('handleDebug edge cases', () => {
    it('should enable debug explicitly', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.debugEnabled = false;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('debug on', ctx);
      expect(state.debugEnabled).toBe(true);
      expect(actions.persistState).toHaveBeenCalled();
    });

    it('should disable debug explicitly', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.debugEnabled = true;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('debug off', ctx);
      expect(state.debugEnabled).toBe(false);
      expect(actions.persistState).toHaveBeenCalled();
    });

    it('should toggle debug when no arg given', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.debugEnabled = false;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('debug', ctx);
      expect(state.debugEnabled).toBe(true);

      await cmd.handler('debug', ctx);
      expect(state.debugEnabled).toBe(false);
    });

    it('should show message when debug history is empty', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.debugHistory.length = 0;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('debug show', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'No recent routing decisions.',
        'info',
      );
    });

    it('should show error with too many args', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('debug on extra', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router debug <on|off|show|clear>',
        'error',
      );
    });
  });

  describe('handleReload edge cases', () => {
    it('should show error with extra args', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('reload extra', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router reload (no arguments)',
        'error',
      );
    });
  });

  describe('Autocomplete completions', () => {
    it('should return thinking completions for first arg', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      const completions = cmd.getArgumentCompletions('thinking ');
      expect(completions).toBeDefined();
      const values = completions!.map((c) => c.value);
      // Should have levels and tiers
      expect(values).toContain('thinking auto');
      expect(values).toContain('thinking high');
    });

    it('should return null when thinking first arg is a level-tier overlap', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      // 'high' is both a tier and a level; level check comes first, so no further completions
      const completions = cmd.getArgumentCompletions('thinking high a');
      expect(completions).toBeNull();
    });

    it('should return null for thinking completions after level arg', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      // 'auto' is a level, so no further completions
      const completions = cmd.getArgumentCompletions('thinking auto ');
      expect(completions).toBeNull();
    });

    it('should return fix completions', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      const completions = cmd.getArgumentCompletions('fix ');
      expect(completions).toBeDefined();
      const values = completions!.map((c) => c.value);
      expect(values).toContain('fix high');
      expect(values).toContain('fix medium');
      expect(values).toContain('fix low');
    });

    it('should return widget completions', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      const completions = cmd.getArgumentCompletions('widget ');
      expect(completions).toBeDefined();
      const values = completions!.map((c) => c.value);
      expect(values).toContain('widget on');
      expect(values).toContain('widget off');
      expect(values).toContain('widget toggle');
    });

    it('should return debug completions', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      const completions = cmd.getArgumentCompletions('debug ');
      expect(completions).toBeDefined();
      const values = completions!.map((c) => c.value);
      expect(values).toContain('debug on');
      expect(values).toContain('debug off');
      expect(values).toContain('debug show');
      expect(values).toContain('debug clear');
    });

    it('should return null for unknown subcommand completions', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      const completions = cmd.getArgumentCompletions('unknown ');
      expect(completions).toBeNull();
    });

    it('should filter subcommand completions by prefix', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      const completions = cmd.getArgumentCompletions('st');
      expect(completions).toBeDefined();
      const values = completions!.map((c) => c.value);
      expect(values).toContain('status');
      expect(values).not.toContain('profile');
    });
  });

  describe('Default handler branch', () => {
    it('should show error for unknown subcommand', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('nonexistent', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Unknown router subcommand: nonexistent'),
        'error',
      );
    });

    it('should treat profile name as subcommand (backward compat)', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('cheap', ctx);
      expect(actions.switchToRouterProfile).toHaveBeenCalledWith('cheap', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Router enabled with profile'),
        'info',
      );
    });

    it('should show error when profile name has extra args', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('balanced extra', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('no extra arguments allowed'),
        'error',
      );
    });

    it('should fall through to status on empty args', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Model Router Status:'),
        'info',
      );
    });

    it('should show help with /router help', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('help', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Router Subcommands:'),
        'info',
      );
    });

    it('should show help with /router ?', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('?', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Router Subcommands:'),
        'info',
      );
    });

    it('should show error when help has extra args', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('help extra', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router help (no arguments)',
        'error',
      );
    });
  });
});
