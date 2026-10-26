import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  type RouterConfig,
  type RouterExtensionAPI,
  type RouterExtensionContext,
  type RouterModelRegistry,
  type RoutingDecision,
  type RouterPinByProfile,
  type RouterThinkingByProfile,
  type RouterTier,
  type CustomSessionEntry,
} from './types';
import {
  loadRouterConfig,
  profileNames,
  resolveProfileName,
  applyThinkingOverride,
  getUnsupportedTiers,
} from './config';
import { MAX_DEBUG_HISTORY } from './constants';
import { isRouterPersistedState, buildPersistedState } from './state';
import {
  updateStatus,
  formatDecision,
  formatUnsupportedThinkingWarning,
} from './ui';
import { registerCommands } from './commands';
import {
  registerRouterProvider,
  markMessageCostCounted,
  extractUncountedMessageCost,
} from './provider';

const routerExtension = <
  TCtx extends RouterExtensionContext = ExtensionContext,
>(
  pi: RouterExtensionAPI<TCtx>,
) => {
  const state = {
    currentConfig: { profiles: {} } as RouterConfig,
    currentModelRegistry: undefined as RouterModelRegistry | undefined,
    currentCwd: process.cwd(),
    lastDecision: undefined as RoutingDecision | undefined,
    debugEnabled: false,
    routerEnabled: false,
    selectedProfile: undefined as string | undefined,
    widgetEnabled: false,
    lastRegisteredModels: '',
    pinnedTierByProfile: {} as RouterPinByProfile,
    thinkingByProfile: {} as RouterThinkingByProfile,
    debugHistory: [] as RoutingDecision[],
    lastNonRouterModel: undefined as string | undefined,
    accumulatedCost: 0,
    lastExtensionContext: undefined as TCtx | undefined,
    lastConfigWarnings: [] as string[],
  };
  let lastPersistedSnapshot: string | undefined;
  let isInitialized = false;
  let isInternalModelSwitch = false;
  let internalThinkingChangeDepth = 0;

  const setModelInternally = async (
    model: NonNullable<ExtensionContext['model']>,
    ctx: TCtx,
  ) => {
    if (ctx.model?.provider === model.provider && ctx.model?.id === model.id) {
      return true;
    }
    isInternalModelSwitch = true;
    try {
      return await pi.setModel(model);
    } catch {
      // Extension context may be stale after session teardown.
      return false;
    } finally {
      isInternalModelSwitch = false;
    }
  };

  const setThinkingLevelInternally = (level: ThinkingLevel) => {
    internalThinkingChangeDepth++;
    try {
      pi.setThinkingLevel(level);
    } catch {
      // Extension context may be stale after session teardown.
    } finally {
      setTimeout(() => {
        internalThinkingChangeDepth--;
      }, 0);
    }
  };

  const recordDebugDecision = (decision: RoutingDecision) => {
    state.debugHistory = [...state.debugHistory, decision].slice(
      -MAX_DEBUG_HISTORY,
    );
    if (state.debugEnabled && state.lastExtensionContext) {
      try {
        state.lastExtensionContext.ui.notify(
          `[router] ${formatDecision(decision)}`,
          'info',
        );
      } catch {
        // Ignore notification errors on stale context.
      }
    }
  };

  const getThinkingOverride = (profileName: string, tier: RouterTier) => {
    return state.thinkingByProfile[profileName]?.[tier];
  };

  const persistState = () => {
    const persisted = buildPersistedState(
      state.routerEnabled,
      state.selectedProfile,
      state.pinnedTierByProfile,
      state.thinkingByProfile,
      state.debugEnabled,
      state.widgetEnabled,
      state.debugHistory,
      state.lastDecision,
      state.lastNonRouterModel,
      state.accumulatedCost,
    );
    const snapshot = JSON.stringify({
      ...persisted,
      timestamp: 0,
      lastDecision: persisted.lastDecision
        ? { ...persisted.lastDecision, timestamp: 0 }
        : undefined,
      debugHistory: persisted.debugHistory?.map((decision) => ({
        ...decision,
        timestamp: 0,
      })),
    });
    if (snapshot === lastPersistedSnapshot) {
      return;
    }
    try {
      pi.appendEntry('router-state', persisted);
    } catch {
      // Defensive fallback: the session_shutdown event may fire after this
      // code runs (due to event loop ordering), so isActive can still be
      // true even though the runtime is already stale.
      return;
    }
    lastPersistedSnapshot = snapshot;
  };

  const actions = {
    persistState,
    recordDebugDecision,
    getThinkingOverride,
    syncPiThinkingLevel: setThinkingLevelInternally,
    updateStatus: (ctx: TCtx) =>
      updateStatus(
        ctx,
        state.routerEnabled,
        state.selectedProfile,
        state.pinnedTierByProfile,
        state.thinkingByProfile,
        state.lastDecision,
        state.lastNonRouterModel,
        state.accumulatedCost,
        state.widgetEnabled,
        state.currentConfig,
      ),
    reloadConfig: (ctx?: TCtx, options?: { preserveDebug?: boolean }) => {
      const loaded = loadRouterConfig(state.currentCwd);
      state.currentConfig = loaded.config;
      state.lastConfigWarnings = loaded.warnings;
      if (!options?.preserveDebug) {
        state.debugEnabled = state.currentConfig.debug ?? false;
      }
      state.selectedProfile = resolveProfileName(
        state.currentConfig,
        state.selectedProfile,
      );
      actions.registerRouterProvider();
      if (ctx) {
        actions.updateStatus(ctx);
        if (state.lastConfigWarnings.length > 0) {
          ctx.ui.notify(
            `Router Configuration Warnings:\n${state.lastConfigWarnings.join('\n')}`,
            'warning',
          );
        }
      }
    },
    ensureValidActiveRouterProfile: async (ctx: TCtx) => {
      if (ctx.model?.provider !== 'router') {
        return;
      }
      if (state.currentConfig.profiles[ctx.model.id]) {
        state.selectedProfile = ctx.model.id;
        state.routerEnabled = true;
        return;
      }

      // The active router model's profile no longer exists in config
      ctx.ui.notify(
        `Router profile "${ctx.model.id}" is no longer configured.`,
        'warning',
      );
      state.routerEnabled = false;
      state.selectedProfile = undefined;
    },
    switchToRouterProfile: async (
      profileName: string,
      ctx: TCtx,
      strict = true,
    ) => {
      if (!state.currentConfig.profiles[profileName]) {
        if (strict) {
          ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        }
        return false;
      }

      // Ensure the provider is registered with current capacities for this profile
      actions.registerRouterProvider();

      const routerModel = ctx.modelRegistry.find('router', profileName);
      if (!routerModel) {
        ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        return false;
      }
      if (ctx.model && ctx.model.provider !== 'router') {
        state.lastNonRouterModel = `${ctx.model.provider}/${ctx.model.id}`;
      }
      const success = await setModelInternally(routerModel, ctx);
      if (!success) {
        ctx.ui.notify(`Failed to switch to router/${profileName}`, 'error');
        return false;
      }
      state.selectedProfile = profileName;
      state.routerEnabled = true;
      persistState();
      actions.updateStatus(ctx);
      return true;
    },
    registerRouterProvider: () => {
      registerRouterProvider(pi, state, actions);
    },
  };

  actions.reloadConfig();

  const restoreStateFromSession = async (ctx: TCtx) => {
    state.lastExtensionContext = ctx;
    state.currentModelRegistry = ctx.modelRegistry;
    state.currentCwd = ctx.cwd;
    actions.reloadConfig(ctx);

    state.routerEnabled = ctx.model?.provider === 'router';
    state.selectedProfile =
      ctx.model?.provider === 'router'
        ? resolveProfileName(state.currentConfig, ctx.model.id)
        : resolveProfileName(state.currentConfig, state.selectedProfile);
    // Clear in-place to keep references intact
    for (const key of Object.keys(state.pinnedTierByProfile)) {
      delete state.pinnedTierByProfile[key];
    }
    for (const key of Object.keys(state.thinkingByProfile)) {
      delete state.thinkingByProfile[key];
    }
    state.widgetEnabled = false;
    state.debugHistory = [];
    state.accumulatedCost = 0;
    state.lastNonRouterModel =
      ctx.model && ctx.model.provider !== 'router'
        ? `${ctx.model.provider}/${ctx.model.id}`
        : state.lastNonRouterModel;
    state.lastDecision = undefined;

    const entries: readonly CustomSessionEntry[] =
      ctx.sessionManager.getBranch();
    for (const entry of entries) {
      if (entry.type === 'message' && entry.message !== undefined) {
        markMessageCostCounted(entry.message);
      }
    }
    const savedState = entries
      .filter(
        (entry) =>
          entry.type === 'custom' && entry.customType === 'router-state',
      )
      .map((entry) => entry.data)
      .findLast((data) => isRouterPersistedState(data));

    if (isRouterPersistedState(savedState)) {
      state.selectedProfile = resolveProfileName(
        state.currentConfig,
        savedState.selectedProfile,
      );
      state.routerEnabled = savedState.enabled;
      if (savedState.pinByProfile) {
        Object.assign(state.pinnedTierByProfile, savedState.pinByProfile);
      }
      if (savedState.thinkingByProfile) {
        Object.assign(state.thinkingByProfile, savedState.thinkingByProfile);
      }
      if (savedState.pinTier && state.selectedProfile) {
        state.pinnedTierByProfile[state.selectedProfile] = savedState.pinTier;
      }
      state.debugEnabled = savedState.debugEnabled ?? state.debugEnabled;
      state.widgetEnabled = savedState.widgetEnabled ?? state.widgetEnabled;
      state.debugHistory = savedState.debugHistory
        ? [...savedState.debugHistory].slice(-MAX_DEBUG_HISTORY)
        : [];
      state.lastNonRouterModel =
        savedState.lastNonRouterModel ?? state.lastNonRouterModel;
      state.accumulatedCost = savedState.accumulatedCost ?? 0;
      state.lastDecision = savedState.lastDecision;
    }

    await actions.ensureValidActiveRouterProfile(ctx);

    if (state.routerEnabled && state.selectedProfile) {
      const routerModel = ctx.modelRegistry.find(
        'router',
        state.selectedProfile,
      );
      if (routerModel) {
        const success = await setModelInternally(routerModel, ctx);
        if (!success) {
          ctx.ui.notify(
            `Failed to restore router/${state.selectedProfile} after relaunch.`,
            'warning',
          );
          state.routerEnabled = false;
        } else if (state.lastDecision) {
          // Sync pi's thinking level display with the router's last decision
          setThinkingLevelInternally(state.lastDecision.thinking);
        }
      } else {
        ctx.ui.notify(
          `Unable to restore router/${state.selectedProfile}; model is unavailable.`,
          'warning',
        );
        state.routerEnabled = false;
      }
    }

    persistState();
    actions.updateStatus(ctx);
  };

  registerCommands(pi, state, actions);

  pi.on('session_start', async (_event, ctx) => {
    isInitialized = false;
    await restoreStateFromSession(ctx);
    isInitialized = true;
    if (state.debugEnabled) {
      ctx.ui.notify(
        `Router initialized with profiles: ${profileNames(state.currentConfig).join(', ')}`,
        'info',
      );
    }
  });

  pi.on('session_tree', async (_event, ctx) => {
    await restoreStateFromSession(ctx);
  });

  // Eagerly initialize the model registry from any event that provides
  // ExtensionContext. In subagent contexts (e.g. pi-dynamic-workflows),
  // session_start may never fire, but turn_start/model_select fire before every LLM
  // call — including the first call to the router provider's streamSimple.
  // Only set when not already initialized: if extensions share instances across
  // parent/subagent sessions, always overwriting would replace the parent's valid
  // registry with the subagent's — which goes stale when the subagent ends.
  const ensureInitializedFromContext = (ctx: TCtx) => {
    if (!state.currentModelRegistry) {
      state.currentModelRegistry = ctx.modelRegistry;
      state.lastExtensionContext = ctx;
      state.currentCwd = ctx.cwd;
      actions.reloadConfig(ctx);
    }
  };

  pi.on('turn_start', async (_event, ctx) => {
    ensureInitializedFromContext(ctx);
    actions.registerRouterProvider();
  });

  pi.on('model_select', async (event, ctx) => {
    ensureInitializedFromContext(ctx);
    if (!isInitialized || isInternalModelSwitch) return;
    if (event.model.provider === 'router') {
      const profileName = resolveProfileName(
        state.currentConfig,
        event.model.id,
      );
      if (!profileName) {
        ctx.ui.notify(`Unknown router profile: ${event.model.id}`, 'error');
        return;
      }

      state.routerEnabled = true;
      state.selectedProfile = profileName;
    } else {
      state.routerEnabled = false;
      state.lastNonRouterModel = `${event.model.provider}/${event.model.id}`;
    }
    persistState();
    actions.updateStatus(ctx);
  });

  pi.on('turn_end', async (event, ctx) => {
    ensureInitializedFromContext(ctx);
    if (state.routerEnabled) {
      state.accumulatedCost += extractUncountedMessageCost(event);
    }
    persistState();
    actions.updateStatus(ctx);
  });

  pi.on('thinking_level_select', (event, ctx) => {
    ensureInitializedFromContext(ctx);
    if (!isInitialized || !state.routerEnabled || !state.selectedProfile)
      return;
    if (internalThinkingChangeDepth > 0 || isInternalModelSwitch) return;
    if (
      ctx.model?.provider !== 'router' ||
      ctx.model?.id !== state.selectedProfile
    ) {
      return;
    }

    // User changed pi's thinking level (e.g. via shift+tab).
    // Apply as an all-tier thinking override for the active router profile.
    applyThinkingOverride(
      state.thinkingByProfile,
      state.selectedProfile,
      'all',
      event.level,
    );
    persistState();
    actions.updateStatus(ctx);
    const unsupported = getUnsupportedTiers(
      state.currentConfig.profiles[state.selectedProfile],
      event.level,
      ctx.modelRegistry,
    );
    if (unsupported.length > 0) {
      ctx.ui.notify(
        formatUnsupportedThinkingWarning('all', event.level, unsupported),
        'warning',
      );
    }
  });
};

export default routerExtension;
