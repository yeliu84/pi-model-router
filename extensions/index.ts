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
  ROUTER_TIERS,
  getUnsupportedTiers,
} from './config';
import { MAX_DEBUG_HISTORY } from './constants';
import { isRouterPersistedState, buildPersistedState } from './state';
import { updateStatus, formatDecision } from './ui';
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
  let currentConfig: RouterConfig = { profiles: {} };
  let currentModelRegistry: RouterModelRegistry | undefined;
  let currentCwd = process.cwd();
  let lastDecision: RoutingDecision | undefined;
  let debugEnabled = false;
  let routerEnabled = false;
  let selectedProfile: string | undefined = undefined;
  let widgetEnabled = false;
  let lastRegisteredModels = '';
  let pinnedTierByProfile: RouterPinByProfile = {};
  let thinkingByProfile: RouterThinkingByProfile = {};
  let debugHistory: RoutingDecision[] = [];
  let lastNonRouterModel: string | undefined;
  let accumulatedCost = 0;
  let lastExtensionContext: TCtx | undefined;
  let lastConfigWarnings: string[] = [];
  let lastPersistedSnapshot: string | undefined;
  let isInitialized = false;
  let isInternalModelSwitch = false;
  let isInternalThinkingChange = false;

  const setModelInternally = async (
    model: NonNullable<ExtensionContext['model']>,
  ) => {
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
    isInternalThinkingChange = true;
    try {
      pi.setThinkingLevel(level);
    } catch {
      // Extension context may be stale after session teardown.
    } finally {
      isInternalThinkingChange = false;
    }
  };

  const recordDebugDecision = (decision: RoutingDecision) => {
    debugHistory = [...debugHistory, decision].slice(-MAX_DEBUG_HISTORY);
    if (debugEnabled && lastExtensionContext) {
      try {
        lastExtensionContext.ui.notify(
          `[router] ${formatDecision(decision)}`,
          'info',
        );
      } catch {
        // Ignore notification errors on stale context.
      }
    }
  };

  const getThinkingOverride = (profileName: string, tier: RouterTier) => {
    return thinkingByProfile[profileName]?.[tier];
  };

  const persistState = () => {
    const state = buildPersistedState(
      routerEnabled,
      selectedProfile,
      pinnedTierByProfile,
      thinkingByProfile,
      debugEnabled,
      widgetEnabled,
      debugHistory,
      lastDecision,
      lastNonRouterModel,
      accumulatedCost,
    );
    const snapshot = JSON.stringify({
      ...state,
      timestamp: 0,
      lastDecision: state.lastDecision
        ? { ...state.lastDecision, timestamp: 0 }
        : undefined,
      debugHistory: state.debugHistory?.map((decision) => ({
        ...decision,
        timestamp: 0,
      })),
    });
    if (snapshot === lastPersistedSnapshot) {
      return;
    }
    try {
      pi.appendEntry('router-state', state);
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
    syncPiThinkingLevel: setThinkingLevelInternally,
    updateStatus: (ctx: TCtx) =>
      updateStatus(
        ctx,
        routerEnabled,
        selectedProfile,
        pinnedTierByProfile,
        thinkingByProfile,
        lastDecision,
        lastNonRouterModel,
        accumulatedCost,
        widgetEnabled,
        currentConfig,
      ),
    reloadConfig: (ctx?: TCtx, options?: { preserveDebug?: boolean }) => {
      const loaded = loadRouterConfig(currentCwd);
      currentConfig = loaded.config;
      lastConfigWarnings = loaded.warnings;
      if (!options?.preserveDebug) {
        debugEnabled = currentConfig.debug ?? false;
      }
      selectedProfile = resolveProfileName(currentConfig, selectedProfile);
      actions.registerRouterProvider();
      if (ctx) {
        actions.updateStatus(ctx);
        if (lastConfigWarnings.length > 0) {
          ctx.ui.notify(
            `Router Configuration Warnings:\n${lastConfigWarnings.join('\n')}`,
            'warning',
          );
        }
      }
    },
    ensureValidActiveRouterProfile: async (ctx: TCtx) => {
      if (ctx.model?.provider !== 'router') {
        return;
      }
      if (currentConfig.profiles[ctx.model.id]) {
        selectedProfile = ctx.model.id;
        routerEnabled = true;
        return;
      }

      // The active router model's profile no longer exists in config
      ctx.ui.notify(
        `Router profile "${ctx.model.id}" is no longer configured.`,
        'warning',
      );
      routerEnabled = false;
      selectedProfile = undefined;
    },
    switchToRouterProfile: async (
      profileName: string,
      ctx: TCtx,
      strict = true,
    ) => {
      if (!currentConfig.profiles[profileName]) {
        if (strict) {
          ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        }
        return false;
      }

      // Ensure the provider is registered with current capacities for this profile
      actions.registerRouterProvider();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const routerModel = ctx.modelRegistry.find('router', profileName);
      if (!routerModel) {
        ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        return false;
      }
      if (ctx.model && ctx.model.provider !== 'router') {
        lastNonRouterModel = `${ctx.model.provider}/${ctx.model.id}`;
      }
      const success = await setModelInternally(routerModel);
      if (!success) {
        ctx.ui.notify(`Failed to switch to router/${profileName}`, 'error');
        return false;
      }
      selectedProfile = profileName;
      routerEnabled = true;
      persistState();
      actions.updateStatus(ctx);
      return true;
    },
    registerRouterProvider: () => {
      registerRouterProvider(
        pi,
        {
          get lastRegisteredModels() {
            return lastRegisteredModels;
          },
          set lastRegisteredModels(v) {
            lastRegisteredModels = v;
          },
          get currentConfig() {
            return currentConfig;
          },
          get currentModelRegistry() {
            return currentModelRegistry;
          },
          get lastExtensionContext() {
            return lastExtensionContext;
          },
          get selectedProfile() {
            return selectedProfile;
          },
          set selectedProfile(v) {
            selectedProfile = v;
          },
          get routerEnabled() {
            return routerEnabled;
          },
          set routerEnabled(v) {
            routerEnabled = v;
          },
          get lastDecision() {
            return lastDecision;
          },
          set lastDecision(v) {
            lastDecision = v;
          },
          thinkingByProfile,
          pinnedTierByProfile,
          get accumulatedCost() {
            return accumulatedCost;
          },
          set accumulatedCost(v) {
            accumulatedCost = v;
          },
        },
        {
          persistState,
          recordDebugDecision,
          getThinkingOverride,
          updateStatus: actions.updateStatus,
          syncPiThinkingLevel: setThinkingLevelInternally,
        },
      );
    },
  };

  actions.reloadConfig();

  const restoreStateFromSession = async (ctx: TCtx) => {
    lastExtensionContext = ctx;
    currentModelRegistry = ctx.modelRegistry;
    currentCwd = ctx.cwd;
    actions.reloadConfig(ctx);

    // Give the registry a moment to synchronize after re-registration
    await new Promise((resolve) => setTimeout(resolve, 50));

    routerEnabled = ctx.model?.provider === 'router';
    selectedProfile =
      ctx.model?.provider === 'router'
        ? resolveProfileName(currentConfig, ctx.model.id)
        : resolveProfileName(currentConfig, selectedProfile);
    // Clear in-place to keep references intact
    for (const key of Object.keys(pinnedTierByProfile)) {
      delete pinnedTierByProfile[key];
    }
    for (const key of Object.keys(thinkingByProfile)) {
      delete thinkingByProfile[key];
    }
    widgetEnabled = false;
    debugHistory = [];
    accumulatedCost = 0;
    lastNonRouterModel =
      ctx.model && ctx.model.provider !== 'router'
        ? `${ctx.model.provider}/${ctx.model.id}`
        : lastNonRouterModel;
    lastDecision = undefined;

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
      selectedProfile = resolveProfileName(
        currentConfig,
        savedState.selectedProfile,
      );
      routerEnabled = savedState.enabled;
      if (savedState.pinByProfile) {
        Object.assign(pinnedTierByProfile, savedState.pinByProfile);
      }
      if (savedState.thinkingByProfile) {
        Object.assign(thinkingByProfile, savedState.thinkingByProfile);
      }
      if (savedState.pinTier && selectedProfile) {
        pinnedTierByProfile[selectedProfile] = savedState.pinTier;
      }
      debugEnabled = savedState.debugEnabled ?? debugEnabled;
      widgetEnabled = savedState.widgetEnabled ?? widgetEnabled;
      debugHistory = savedState.debugHistory
        ? [...savedState.debugHistory].slice(-MAX_DEBUG_HISTORY)
        : [];
      lastNonRouterModel = savedState.lastNonRouterModel ?? lastNonRouterModel;
      accumulatedCost = savedState.accumulatedCost ?? 0;
      lastDecision = savedState.lastDecision;
    }

    await actions.ensureValidActiveRouterProfile(ctx);

    if (routerEnabled && selectedProfile) {
      const routerModel = ctx.modelRegistry.find('router', selectedProfile);
      if (routerModel) {
        const success = await setModelInternally(routerModel);
        if (!success) {
          ctx.ui.notify(
            `Failed to restore router/${selectedProfile} after relaunch.`,
            'warning',
          );
          routerEnabled = false;
        } else if (lastDecision) {
          // Sync pi's thinking level display with the router's last decision
          setThinkingLevelInternally(lastDecision.thinking);
        }
      } else {
        ctx.ui.notify(
          `Unable to restore router/${selectedProfile}; model is unavailable.`,
          'warning',
        );
        routerEnabled = false;
        ctx.ui.setHiddenThinkingLabel?.();
      }
    } else {
      ctx.ui.setHiddenThinkingLabel?.();
    }

    persistState();
    actions.updateStatus(ctx);
  };

  registerCommands(
    pi,
    {
      get currentConfig() {
        return currentConfig;
      },
      get routerEnabled() {
        return routerEnabled;
      },
      set routerEnabled(v) {
        routerEnabled = v;
      },
      get selectedProfile() {
        return selectedProfile;
      },
      set selectedProfile(v) {
        selectedProfile = v;
      },
      pinnedTierByProfile,
      thinkingByProfile,
      get lastDecision() {
        return lastDecision;
      },
      get lastNonRouterModel() {
        return lastNonRouterModel;
      },
      set lastNonRouterModel(v) {
        lastNonRouterModel = v;
      },
      get accumulatedCost() {
        return accumulatedCost;
      },
      get debugEnabled() {
        return debugEnabled;
      },
      set debugEnabled(v) {
        debugEnabled = v;
      },
      get widgetEnabled() {
        return widgetEnabled;
      },
      set widgetEnabled(v) {
        widgetEnabled = v;
      },
      get debugHistory() {
        return debugHistory;
      },
      get lastConfigWarnings() {
        return lastConfigWarnings;
      },
    },
    actions,
  );

  pi.on('session_start', async (_event, ctx) => {
    isInitialized = false;
    await restoreStateFromSession(ctx);
    isInitialized = true;
    if (debugEnabled) {
      ctx.ui.notify(
        `Router initialized with profiles: ${profileNames(currentConfig).join(', ')}`,
        'info',
      );
    }
  });

  // Eagerly initialize the model registry from any event that provides
  // ExtensionContext. In subagent contexts (e.g. pi-dynamic-workflows),
  // session_start may never fire, but turn_start/model_select fire before every LLM
  // call — including the first call to the router provider's streamSimple.
  // Only set when not already initialized: if extensions share instances across
  // parent/subagent sessions, always overwriting would replace the parent's valid
  // registry with the subagent's — which goes stale when the subagent ends.
  const ensureInitializedFromContext = (ctx: TCtx) => {
    if (!currentModelRegistry) {
      currentModelRegistry = ctx.modelRegistry;
      lastExtensionContext = ctx;
      currentCwd = ctx.cwd;
      actions.reloadConfig(ctx);
    }
  };

  pi.on('turn_start', async (_event, ctx) => {
    ensureInitializedFromContext(ctx);
    actions.registerRouterProvider();
  });

  pi.on('model_select', async (event, ctx) => {
    // Ensure the model registry is captured even if session_start hasn't fired
    // (e.g. in subagent contexts spawned by pi-dynamic-workflows).
    ensureInitializedFromContext(ctx);
    if (!isInitialized || isInternalModelSwitch) return;
    if (event.model.provider === 'router') {
      const profileName = resolveProfileName(currentConfig, event.model.id);
      if (!profileName) {
        ctx.ui.notify(`Unknown router profile: ${event.model.id}`, 'error');
        return;
      }

      // If the selected model has stale capacities (e.g. from the initial registration),
      // re-apply the model from the registry to force a TUI refresh.
      const registryModel = ctx.modelRegistry.find('router', profileName);
      if (
        registryModel &&
        (registryModel.contextWindow !== event.model.contextWindow ||
          registryModel.maxTokens !== event.model.maxTokens)
      ) {
        await setModelInternally(registryModel);
      }

      routerEnabled = true;
      selectedProfile = profileName;
    } else {
      routerEnabled = false;
      lastNonRouterModel = `${event.model.provider}/${event.model.id}`;
      ctx.ui.setHiddenThinkingLabel?.();
    }
    persistState();
    actions.updateStatus(ctx);
  });

  pi.on('turn_end', async (event, ctx) => {
    ensureInitializedFromContext(ctx);
    if (routerEnabled) {
      accumulatedCost += extractUncountedMessageCost(event);
    }
    if (routerEnabled && selectedProfile && ctx.model?.provider !== 'router') {
      const routerModel = ctx.modelRegistry.find('router', selectedProfile);
      if (routerModel) {
        await setModelInternally(routerModel);
      }
    }
    persistState();
    actions.updateStatus(ctx);
  });

  pi.on('thinking_level_select', (event, ctx) => {
    ensureInitializedFromContext(ctx);
    if (!isInitialized || !routerEnabled || !selectedProfile) return;
    if (isInternalThinkingChange || isInternalModelSwitch) return;
    if (ctx.model?.provider !== 'router' || ctx.model?.id !== selectedProfile) {
      return;
    }

    // User changed pi's thinking level (e.g. via shift+tab).
    // Apply as an all-tier thinking override for the active router profile.
    if (!thinkingByProfile[selectedProfile]) {
      thinkingByProfile[selectedProfile] = {};
    }
    for (const t of ROUTER_TIERS) {
      thinkingByProfile[selectedProfile]![t] = event.level;
    }
    persistState();
    actions.updateStatus(ctx);
    if (event.level !== 'off') {
      const unsupported = getUnsupportedTiers(
        currentConfig.profiles[selectedProfile],
        event.level,
        ctx.modelRegistry,
      );
      if (unsupported.length > 0) {
        ctx.ui.notify(
          `Router thinking (all) set to ${event.level}. ` +
            `${unsupported.join(', ')} tier${unsupported.length > 1 ? 's' : ''} may not support '${event.level}'.`,
          'warning',
        );
      }
    }
  });
};

export default routerExtension;
