import { describe, it, expect, vi } from 'vitest';
import {
  formatDecision,
  formatPinSummary,
  formatThinkingSummary,
  formatModelRef,
  updateStatus,
} from './ui';
import type { RoutingDecision, RouterConfig } from './types';

describe('ui.ts', () => {
  describe('formatDecision', () => {
    it('should format routing decision correctly', () => {
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        reasoning: 'Exploratory prompts',
        thinking: 'high',
        timestamp: Date.now(),
      };
      const formatted = formatDecision(decision);
      expect(formatted).toBe(
        'balanced: high -> google/gemini-2.5-pro [high] (Exploratory prompts)',
      );
    });
  });

  describe('formatPinSummary', () => {
    it('should format pin configurations sorted alphabetically', () => {
      const pins = {
        cheap: 'low' as const,
        balanced: 'medium' as const,
      };
      expect(formatPinSummary(pins)).toBe('balanced:medium, cheap:low');
    });

    it('should return none if empty', () => {
      expect(formatPinSummary({})).toBe('none');
    });
  });

  describe('formatThinkingSummary', () => {
    it('should format thinking configurations sorted alphabetically', () => {
      const thinking = {
        balanced: { high: 'xhigh' as const, medium: 'low' as const },
        cheap: { low: 'off' as const },
      };
      expect(formatThinkingSummary(thinking)).toBe(
        'balanced(high:xhigh,medium:low), cheap(low:off)',
      );
    });

    it('should return none if empty', () => {
      expect(formatThinkingSummary({})).toBe('none');
    });
  });

  describe('formatModelRef', () => {
    it('should return model name or none', () => {
      expect(formatModelRef('openai/gpt-4o')).toBe('openai/gpt-4o');
      expect(formatModelRef(undefined)).toBe('none');
    });
  });

  describe('updateStatus', () => {
    const mockTheme = {
      fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    };

    const buildMockCtx = () => ({
      ui: {
        setStatus: vi.fn<(key: string, text: string | undefined) => void>(),
        setWidget: vi.fn<(key: string, content: string[] | undefined) => void>(),
        theme: mockTheme,
      },
    });

    const mockConfig: RouterConfig = {
      maxSessionBudget: 10.0,
      profiles: {},
    };

    it('should remove status if disabled', () => {
      const ctx = buildMockCtx();
      updateStatus(
        ctx,
        false,
        'balanced',
        {},
        {},
        undefined,
        undefined,
        0,
        false,
        mockConfig,
      );

      expect(ctx.ui.setStatus).toHaveBeenCalledWith('router', undefined);
      expect(ctx.ui.setWidget).toHaveBeenCalledWith('router', undefined);
    });

    it('should update status to waiting if router is enabled but no last decision matches', () => {
      const ctx = buildMockCtx();
      updateStatus(
        ctx,
        true,
        'balanced',
        {},
        {},
        undefined,
        undefined,
        0,
        false,
        mockConfig,
      );

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'router',
        '🚥 router:balanced -> waiting',
      );
    });

    it('should display last routed decision information when active profile matches', () => {
      const ctx = buildMockCtx();
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        reasoning: 'planning keywords',
        thinking: 'high',
        timestamp: Date.now(),
      };

      updateStatus(
        ctx,
        true,
        'balanced',
        { balanced: 'high' },
        { balanced: { high: 'xhigh' } },
        decision,
        undefined,
        0.005,
        true,
        mockConfig,
      );

      // Check Status
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'router',
        '🚥 router:balanced [pin:high] -> high -> google/gemini-2.5-pro (xhigh)',
      );

      // Check Widget Lines
      expect(ctx.ui.setWidget).toHaveBeenCalled();
      const widgetCalls = vi.mocked(ctx.ui.setWidget).mock.calls[0];
      expect(widgetCalls[0]).toBe('router');
      const widgetLines = widgetCalls[1];
      expect(widgetLines).toContain('[dim]Router: enabled[/dim]');
      expect(widgetLines).toContain('[dim]Profile: balanced (active)[/dim]');
      expect(widgetLines).toContain('[dim]Pin: high[/dim]');
      expect(widgetLines).toContain('[dim]Cost: $0.0050 / $10.00[/dim]');
      expect(widgetLines).toContain(
        '[dim]Route: high -> google/gemini-2.5-pro (xhigh)[/dim]',
      );
      expect(widgetLines).toContain('[dim]Phase: planning[/dim]');
    });

    it('should display fallback model when router is disabled and lastNonRouterModel is set', () => {
      const ctx = buildMockCtx();
      updateStatus(
        ctx,
        false,
        'balanced',
        {},
        {},
        undefined,
        'anthropic/claude-3.5-sonnet',
        0.1,
        true,
        mockConfig,
      );

      // Status should be cleared since router is not active
      expect(ctx.ui.setStatus).toHaveBeenCalledWith('router', undefined);

      // Widget should show fallback model
      const widgetCalls = vi.mocked(ctx.ui.setWidget).mock.calls[0];
      const widgetLines = widgetCalls[1];
      expect(widgetLines).toContain('[dim]Router: disabled[/dim]');
      expect(widgetLines).toContain(
        '[dim]Fallback: anthropic/claude-3.5-sonnet[/dim]',
      );
    });

    it('should show pins line when multiple profiles have pins', () => {
      const ctx = buildMockCtx();
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'medium',
        phase: 'implementation',
        targetProvider: 'openai',
        targetModelId: 'gpt-4o-mini',
        targetLabel: 'openai/gpt-4o-mini',
        reasoning: 'implementation work',
        thinking: 'medium',
        timestamp: Date.now(),
      };

      updateStatus(
        ctx,
        true,
        'balanced',
        { balanced: 'medium', cheap: 'low' },
        {},
        decision,
        undefined,
        0,
        true,
        mockConfig,
      );

      const widgetCalls = vi.mocked(ctx.ui.setWidget).mock.calls[0];
      const widgetLines = widgetCalls[1];
      expect(widgetLines).toContain(
        '[dim]Pins: balanced:medium, cheap:low[/dim]',
      );
    });

    it('should show waiting when active profile does not match lastDecision profile', () => {
      const ctx = buildMockCtx();
      const decision: RoutingDecision = {
        profile: 'other-profile',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        reasoning: 'planning keywords',
        thinking: 'high',
        timestamp: Date.now(),
      };

      updateStatus(
        ctx,
        true,
        'balanced',
        {},
        {},
        decision,
        undefined,
        0,
        false,
        mockConfig,
      );

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'router',
        '🚥 router:balanced -> waiting',
      );
    });

    it('should omit budget denominator from widget when maxSessionBudget is undefined', () => {
      const ctx = buildMockCtx();
      const noBudgetConfig: RouterConfig = {
        profiles: {},
      };
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'medium',
        phase: 'implementation',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-flash',
        targetLabel: 'google/gemini-2.5-flash',
        reasoning: 'test',
        thinking: 'medium',
        timestamp: Date.now(),
      };

      updateStatus(
        ctx,
        true,
        'balanced',
        {},
        {},
        decision,
        undefined,
        0.5,
        true,
        noBudgetConfig,
      );

      const widgetLines = vi.mocked(ctx.ui.setWidget).mock.calls[0][1];
      expect(widgetLines).toBeDefined();
      const costLine = widgetLines!.find((l) => l.includes('Cost'));
      expect(costLine).toBe('[dim]Cost: $0.5000[/dim]');
    });

    it('should omit budget denominator when maxSessionBudget is 0 (falsy)', () => {
      const ctx = buildMockCtx();
      const zeroBudgetConfig: RouterConfig = {
        maxSessionBudget: 0,
        profiles: {},
      };
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'medium',
        phase: 'implementation',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-flash',
        targetLabel: 'google/gemini-2.5-flash',
        reasoning: 'test',
        thinking: 'medium',
        timestamp: Date.now(),
      };

      updateStatus(
        ctx,
        true,
        'balanced',
        {},
        {},
        decision,
        undefined,
        0,
        true,
        zeroBudgetConfig,
      );

      const widgetLines = vi.mocked(ctx.ui.setWidget).mock.calls[0][1];
      expect(widgetLines).toBeDefined();
      const costLine = widgetLines!.find((l) => l.includes('Cost'));
      // maxSessionBudget=0 is falsy, so no denominator is shown
      expect(costLine).toBe('[dim]Cost: $0.0000[/dim]');
    });
  });
});
