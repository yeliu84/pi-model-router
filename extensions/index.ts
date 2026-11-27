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
  type ModelCooldownEntry,
} from './types';
import {
  loadRouterConfig,
  profileNames,
  resolveProfileName,
  applyThinkingOverride,
  isObjectRecord,
} from './config';
import { MAX_DEBUG_HISTORY } from './constants';
import {
  isRouterPersistedState,
  buildPersistedState,
  serializePersistedStateSnapshot,
} from './state';
import { updateStatus, formatDecision, notifyUnsupportedThinking } from './ui';
import { registerCommands } from './commands';
import {
  registerRouterProvider,
  markMessageCostCounted,
  extractUncountedMessageCost,
  resetCountedMessageCosts,
  applyProviderResponseCooldown,
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
    modelCooldowns: new Map<string, ModelCooldownEntry>(),
    inFlightModelRef: undefined as string | undefined,
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

  const syncPiThinkingLevel = (level: ThinkingLevel | undefined) => {
    if (!level) return;
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

  const recordUsageCost = (input: unknown) => {
    const cost = extractUncountedMessageCost(input);
    if (state.routerEnabled) {
      state.accumulatedCost += cost;
    }
  };

  const syncTrailingBranchUsage = (ctx: TCtx) => {
    const entries = ctx.sessionManager?.getBranch?.();
    if (!entries) return;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === 'custom' && entry.customType === 'router-state') {
        break;
      }
      recordUsageCost(entry);
    }
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
    const snapshot = serializePersistedStateSnapshot(persisted);
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
    syncPiThinkingLevel,
    syncTrailingUsage: (ctx: TCtx) => {
      syncTrailingBranchUsage(ctx);
      persistState();
    },
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
        state.modelCooldowns,
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
    state.inFlightModelRef = undefined;
    lastPersistedSnapshot = undefined;
    resetCountedMessageCosts();
    state.lastNonRouterModel =
      ctx.model && ctx.model.provider !== 'router'
        ? `${ctx.model.provider}/${ctx.model.id}`
        : state.lastNonRouterModel;
    state.lastDecision = undefined;

    const entries: readonly CustomSessionEntry[] =
      ctx.sessionManager.getBranch();
    const lastRouterStateIndex = entries.findLastIndex(
      (entry) =>
        entry.type === 'custom' &&
        entry.customType === 'router-state' &&
        isRouterPersistedState(entry.data),
    );
    const savedState =
      lastRouterStateIndex >= 0
        ? entries[lastRouterStateIndex].data
        : undefined;

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

    for (let i = 0; i < entries.length; i++) {
      if (lastRouterStateIndex >= 0 && i > lastRouterStateIndex) {
        recordUsageCost(entries[i]);
      } else {
        markMessageCostCounted(entries[i]);
      }
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
        } else {
          // Sync pi's thinking level display with the router's last decision
          syncPiThinkingLevel(state.lastDecision?.thinking);
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

  const handleUsageEvent = async (event: unknown, ctx: TCtx) => {
    ensureInitializedFromContext(ctx);
    recordUsageCost(event);
    persistState();
    actions.updateStatus(ctx);
  };

  pi.on('session_compact', async (event, ctx) => {
    state.inFlightModelRef = undefined;
    await handleUsageEvent(event, ctx);
  });

  pi.on('session_compact_failed', () => {
    state.inFlightModelRef = undefined;
  });

  pi.on('turn_start', async (_event, ctx) => {
    ensureInitializedFromContext(ctx);
    state.inFlightModelRef =
      ctx.model && ctx.model.provider !== 'router'
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
    syncTrailingBranchUsage(ctx);
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
    state.inFlightModelRef = undefined;
    if (
      isObjectRecord(event) &&
      isObjectRecord(event.message) &&
      event.message.role === 'assistant' &&
      event.message.stopReason !== 'error' &&
      event.message.stopReason !== 'aborted' &&
      typeof event.message.provider === 'string' &&
      typeof event.message.model === 'string'
    ) {
      const succeededRef = `${event.message.provider}/${event.message.model}`;
      state.modelCooldowns.delete(succeededRef);
    }
    await handleUsageEvent(event, ctx);
  });

  pi.on('after_provider_response', (event, ctx) => {
    ensureInitializedFromContext(ctx);
    const changed = applyProviderResponseCooldown(
      state.modelCooldowns,
      state.inFlightModelRef,
      event.status,
      event.headers,
    );
    if (changed && state.widgetEnabled) {
      actions.updateStatus(ctx);
    }
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
    notifyUnsupportedThinking(
      ctx,
      state.currentConfig.profiles[state.selectedProfile],
      'all',
      event.level,
    );
  });
};

export default routerExtension;
