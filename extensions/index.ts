import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import {
  type RouterConfig,
  type RouterPersistedState,
  type RoutingDecision,
  type RouterPinByProfile,
  type RouterThinkingByProfile,
  type RouterTier,
  type CustomSessionEntry,
} from './types';
import {
  FALLBACK_CONFIG,
  loadRouterConfig,
  profileNames,
  resolveProfileName,
  parseCanonicalModelRef,
} from './config';
import { MAX_DEBUG_HISTORY } from './constants';
import { isRouterPersistedState, buildPersistedState } from './state';
import { updateStatus, formatModelRef } from './ui';
import { registerCommands } from './commands';
import { registerRouterProvider } from './provider';

const routerExtension = (pi: ExtensionAPI) => {
  let currentConfig: RouterConfig = FALLBACK_CONFIG;
  let currentModelRegistry: ExtensionContext['modelRegistry'] | undefined;
  let currentCwd = process.cwd();
  let lastDecision: RoutingDecision | undefined;
  let debugEnabled = false;
  let routerEnabled = false;
  let selectedProfile = resolveProfileName(FALLBACK_CONFIG, FALLBACK_CONFIG.defaultProfile);
  let widgetEnabled = false;
  let lastRegisteredModels = '';
  let pinnedTierByProfile: RouterPinByProfile = {};
  let thinkingByProfile: RouterThinkingByProfile = {};
  let debugHistory: RoutingDecision[] = [];
  let lastNonRouterModel: string | undefined;
  let accumulatedCost = 0;
  let lastExtensionContext: ExtensionContext | undefined;
  let lastConfigWarnings: string[] = [];
  let lastPersistedSnapshot: string | undefined;
  let isInitialized = false;

  const getPinnedTierForProfile = (profileName: string): RouterTier | undefined =>
    pinnedTierByProfile[profileName];

  const setPinnedTierForProfile = (profileName: string, tier: RouterTier | undefined) => {
    if (tier) {
      pinnedTierByProfile[profileName] = tier;
    } else {
      delete pinnedTierByProfile[profileName];
    }
  };

  const recordDebugDecision = (decision: RoutingDecision) => {
    debugHistory = [...debugHistory, decision].slice(-MAX_DEBUG_HISTORY);
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
      lastDecision: state.lastDecision ? { ...state.lastDecision, timestamp: 0 } : undefined,
      debugHistory: state.debugHistory?.map((decision) => ({ ...decision, timestamp: 0 })),
    });
    if (snapshot === lastPersistedSnapshot) {
      return;
    }
    pi.appendEntry('router-state', state);
    lastPersistedSnapshot = snapshot;
  };

  const actions = {
    persistState,
    updateStatus: (ctx: ExtensionContext) =>
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
    reloadConfig: (ctx?: ExtensionContext, options?: { preserveDebug?: boolean }) => {
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
      }
    },
    ensureValidActiveRouterProfile: async (ctx: ExtensionContext) => {
      if (ctx.model?.provider !== 'router') {
        return;
      }
      if (currentConfig.profiles[ctx.model.id]) {
        selectedProfile = ctx.model.id;
        routerEnabled = true;
        return;
      }

      const fallbackProfile = resolveProfileName(currentConfig, selectedProfile);
      const routerModel = ctx.modelRegistry.find('router', fallbackProfile);
      selectedProfile = fallbackProfile;
      if (!routerModel) {
        ctx.ui.notify(`Router profile "${ctx.model.id}" is no longer configured.`, 'warning');
        return;
      }

      await pi.setModel(routerModel);
      ctx.ui.notify(
        `Router profile "${ctx.model.id}" is no longer configured. Switched to router/${fallbackProfile}.`,
        'warning',
      );
    },
    switchToRouterProfile: async (profileName: string, ctx: ExtensionContext, strict = true) => {
      if (strict && !currentConfig.profiles[profileName]) {
        ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        return false;
      }
      const resolvedProfile = resolveProfileName(currentConfig, profileName);
      const routerModel = ctx.modelRegistry.find('router', resolvedProfile);
      if (!routerModel) {
        ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        return false;
      }
      if (ctx.model && ctx.model.provider !== 'router') {
        lastNonRouterModel = `${ctx.model.provider}/${ctx.model.id}`;
      }
      const success = await pi.setModel(routerModel);
      if (!success) {
        ctx.ui.notify(`Failed to switch to router/${resolvedProfile}`, 'error');
        return false;
      }
      selectedProfile = resolvedProfile;
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
        },
      );
    },
  };

  actions.reloadConfig();

  const restoreStateFromSession = async (ctx: ExtensionContext) => {
    lastExtensionContext = ctx;
    currentModelRegistry = ctx.modelRegistry;
    currentCwd = ctx.cwd;
    actions.reloadConfig();

    routerEnabled = ctx.model?.provider === 'router';
    selectedProfile = resolveProfileName(
      currentConfig,
      ctx.model?.provider === 'router' ? ctx.model.id : selectedProfile,
    );
    pinnedTierByProfile = {};
    thinkingByProfile = {};
    widgetEnabled = false;
    debugHistory = [];
    accumulatedCost = 0;
    lastNonRouterModel =
      ctx.model && ctx.model.provider !== 'router'
        ? `${ctx.model.provider}/${ctx.model.id}`
        : lastNonRouterModel;
    lastDecision = undefined;

    const entries = ctx.sessionManager.getBranch() as CustomSessionEntry[];
    const savedState = entries
      .filter((entry) => entry.type === 'custom' && entry.customType === 'router-state')
      .map((entry) => entry.data)
      .findLast((data) => isRouterPersistedState(data));

    if (isRouterPersistedState(savedState)) {
      selectedProfile = resolveProfileName(currentConfig, savedState.selectedProfile);
      routerEnabled = savedState.enabled;
      pinnedTierByProfile = savedState.pinByProfile ? { ...savedState.pinByProfile } : {};
      thinkingByProfile = savedState.thinkingByProfile ? { ...savedState.thinkingByProfile } : {};
      if (savedState.pinTier) {
        pinnedTierByProfile[selectedProfile] = savedState.pinTier;
      }
      debugEnabled = savedState.debugEnabled ?? debugEnabled;
      widgetEnabled = savedState.widgetEnabled ?? widgetEnabled;
      debugHistory = savedState.debugHistory
        ? [...savedState.debugHistory].slice(-MAX_DEBUG_HISTORY)
        : [];
      lastNonRouterModel = savedState.lastNonRouterModel ?? lastNonRouterModel;
      accumulatedCost = savedState.accumulatedCost ?? 0;
    }

    await actions.ensureValidActiveRouterProfile(ctx);

    if (routerEnabled && ctx.model?.provider !== 'router') {
      const routerModel = ctx.modelRegistry.find('router', selectedProfile);
      if (routerModel) {
        const success = await pi.setModel(routerModel);
        if (!success) {
          ctx.ui.notify(`Failed to restore router/${selectedProfile} after relaunch.`, 'warning');
          routerEnabled = false;
        }
      } else {
        ctx.ui.notify(
          `Unable to restore router/${selectedProfile}; model is unavailable.`,
          'warning',
        );
        routerEnabled = false;
      }
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
    },
    actions,
  );

  pi.on('session_start', async (_event, ctx) => {
    isInitialized = true;
    await restoreStateFromSession(ctx);
    if (debugEnabled) {
      ctx.ui.notify(
        `Router initialized with profiles: ${profileNames(currentConfig).join(', ')}`,
        'info',
      );
    }
  });

  pi.on('model_select', async (event, ctx) => {
    if (!isInitialized) return;
    if (event.model.provider === 'router') {
      routerEnabled = true;
      selectedProfile = resolveProfileName(currentConfig, event.model.id);
    } else {
      const branchSize = ctx.sessionManager.getBranch().length;
      if (branchSize > 0) {
        routerEnabled = false;
        lastNonRouterModel = `${event.model.provider}/${event.model.id}`;
      }
    }
    persistState();
    actions.updateStatus(ctx);
  });

  pi.on('session_switch', async (_event, ctx) => {
    await restoreStateFromSession(ctx);
  });

  pi.on('session_fork', async (_event, ctx) => {
    await restoreStateFromSession(ctx);
  });

  pi.on('turn_end', async (_event, ctx) => {
    persistState();
    actions.updateStatus(ctx);
  });
};

export default routerExtension;
