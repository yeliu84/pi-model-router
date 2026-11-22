import { describe, it, expect } from 'vitest';
import {
  isRouterPersistedState,
  buildPersistedState,
  serializePersistedStateSnapshot,
  isSameVirtualRouterState,
} from './state';
import type { RoutingDecision, VirtualRouterState } from './types';

describe('state.ts', () => {
  describe('isRouterPersistedState', () => {
    it('should return false for non-objects or null', () => {
      expect(isRouterPersistedState(null)).toBe(false);
      expect(isRouterPersistedState('string')).toBe(false);
      expect(isRouterPersistedState(123)).toBe(false);
    });

    it('should return false if required properties are missing or wrong type', () => {
      expect(isRouterPersistedState({ enabled: true })).toBe(false);
      expect(
        isRouterPersistedState({
          enabled: 'yes',
          selectedProfile: 'p',
          timestamp: 123,
        }),
      ).toBe(false);
    });

    it('should return true for valid persisted state objects', () => {
      const state = {
        enabled: true,
        selectedProfile: 'balanced',
        timestamp: Date.now(),
      };
      expect(isRouterPersistedState(state)).toBe(true);
    });
  });

  describe('buildPersistedState', () => {
    it('should build a state object matching the interface requirements', () => {
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        reasoning: 'Rules matched',
        thinking: 'high',
        timestamp: Date.now(),
      };

      const state = buildPersistedState(
        true,
        'balanced',
        { balanced: 'high' },
        { balanced: { high: 'xhigh' } },
        true,
        false,
        [decision],
        decision,
        'openai/gpt-4o',
        0.0045,
      );

      expect(state.enabled).toBe(true);
      expect(state.selectedProfile).toBe('balanced');
      expect(state.pinTier).toBe('high');
      expect(state.pinByProfile).toEqual({ balanced: 'high' });
      expect(state.thinkingByProfile).toEqual({ balanced: { high: 'xhigh' } });
      expect(state.debugEnabled).toBe(true);
      expect(state.widgetEnabled).toBe(false);
      expect(state.debugHistory).toEqual([decision]);
      expect(state.lastPhase).toBe('planning');
      expect(state.lastDecision).toEqual(decision);
      expect(state.lastNonRouterModel).toBe('openai/gpt-4o');
      expect(state.accumulatedCost).toBe(0.0045);
      expect(state.timestamp).toBeGreaterThan(0);
    });

    it('should handle undefined selectedProfile', () => {
      const state = buildPersistedState(
        false,
        undefined,
        {},
        {},
        false,
        false,
        [],
        undefined,
        undefined,
        0,
      );
      expect(state.selectedProfile).toBe('');
      expect(state.pinTier).toBeUndefined();
    });
  });

  describe('serializePersistedStateSnapshot & isSameVirtualRouterState', () => {
    const baseDecision: RoutingDecision = {
      profile: 'balanced',
      tier: 'medium',
      phase: 'implementation',
      targetProvider: 'openai',
      targetModelId: 'gpt-6.2-sol',
      targetLabel: 'openai/gpt-6.2-sol',
      reasoning: 'Preserved openai/gpt-6.2-sol for continuation.',
      thinking: 'medium',
      timestamp: 1000,
    };

    it('should serialize identical snapshots regardless of timestamps or omitted false flags', () => {
      const stateA = {
        ...buildPersistedState(
          true,
          'balanced',
          {},
          {},
          false,
          false,
          [baseDecision],
          baseDecision,
          undefined,
          0.01,
        ),
        timestamp: 1000,
      };
      const decisionWithFalseFlags: RoutingDecision = {
        ...baseDecision,
        isFallback: false,
        isClassifier: false,
        isBudgetForced: false,
        isRuleMatched: false,
        timestamp: 2000,
      };
      const stateB = {
        ...buildPersistedState(
          true,
          'balanced',
          {},
          {},
          false,
          false,
          [decisionWithFalseFlags],
          decisionWithFalseFlags,
          undefined,
          0.01,
        ),
        timestamp: 2000,
      };

      expect(serializePersistedStateSnapshot(stateA)).toBe(
        serializePersistedStateSnapshot(stateB),
      );
    });

    it('should detect equivalent and differing VirtualRouterState objects', () => {
      const prev: VirtualRouterState = {
        phase: 'implementation',
        tier: 'medium',
        lastDecision: baseDecision,
      };
      const sameNext: VirtualRouterState = {
        phase: 'implementation',
        tier: 'medium',
        lastDecision: {
          ...baseDecision,
          timestamp: 9999,
          isFallback: false,
        },
      };
      const changedNext: VirtualRouterState = {
        ...sameNext,
        lastDecision: {
          ...sameNext.lastDecision,
          isFallback: true,
        },
      };

      expect(isSameVirtualRouterState(undefined, prev)).toBe(false);
      expect(
        isSameVirtualRouterState(
          {
            phase: 'implementation',
            tier: 'medium',
          } as VirtualRouterState,
          prev,
        ),
      ).toBe(false);
      expect(isSameVirtualRouterState(prev, sameNext)).toBe(true);
      expect(isSameVirtualRouterState(prev, changedNext)).toBe(false);
    });
  });
});
