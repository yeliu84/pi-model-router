import type {
  ExtensionAPI,
  ExtensionContext,
  CommandCompletionItem,
} from '@mariozechner/pi-coding-agent';
import type {
  RouterConfig,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RoutingDecision,
  RouterTier,
} from './types';
import {
  profileNames,
  resolveProfileName,
  THINKING_LEVELS,
  ROUTER_PIN_VALUES,
  ROUTER_TIERS,
  parseCanonicalModelRef,
} from './config';
import {
  formatPinSummary,
  formatThinkingSummary,
  formatModelRef,
  formatDecision,
} from './ui';

export const registerCommands = (
  pi: ExtensionAPI,
  state: {
    readonly currentConfig: RouterConfig;
    routerEnabled: boolean;
    selectedProfile: string;
    readonly pinnedTierByProfile: RouterPinByProfile;
    readonly thinkingByProfile: RouterThinkingByProfile;
    readonly lastDecision: RoutingDecision | undefined;
    lastNonRouterModel: string | undefined;
    readonly accumulatedCost: number;
    debugEnabled: boolean;
    widgetEnabled: boolean;
    readonly debugHistory: RoutingDecision[];
  },
  actions: {
    persistState: () => void;
    updateStatus: (ctx: ExtensionContext) => void;
    reloadConfig: (
      ctx?: ExtensionContext,
      options?: { preserveDebug?: boolean },
    ) => void;
    ensureValidActiveRouterProfile: (ctx: ExtensionContext) => Promise<void>;
    switchToRouterProfile: (
      profileName: string,
      ctx: ExtensionContext,
      strict?: boolean,
    ) => Promise<boolean>;
  },
) => {
  const SUBCOMMAND_DETAILS = [
    { name: 'status', desc: 'Show current router status' },
    { name: 'profile', desc: 'Switch to a different router profile' },
    { name: 'pin', desc: 'Pin routing for a profile to a specific tier' },
    { name: 'thinking', desc: 'Override thinking level for a tier or profile' },
    { name: 'disable', desc: 'Disable the router and restore last model' },
    {
      name: 'fix',
      desc: 'Correct the last routing decision and pin that tier',
    },
    { name: 'widget', desc: 'Toggle the router status widget' },
    { name: 'debug', desc: 'Toggle or clear router debug history' },
    { name: 'reload', desc: 'Reload the model router configuration' },
    { name: 'help', desc: 'Show usage help for subcommands' },
  ];

  const getSubcommandCompletions = (
    prefix: string,
  ): CommandCompletionItem[] | null => {
    const items = SUBCOMMAND_DETAILS.filter((s) =>
      s.name.startsWith(prefix),
    ).map((s) => ({
      value: s.name,
      label: s.name,
      description: s.desc,
    }));
    return items.length > 0 ? items : null;
  };

  const getPinCompletions = (
    args: string[],
  ): CommandCompletionItem[] | null => {
    // pin [profile] <tier|auto>
    if (args.length <= 1) {
      const token = args[0] ?? '';
      const pinItems = ROUTER_PIN_VALUES.filter((value) =>
        value.startsWith(token),
      ).map((value) => ({
        value,
        label: value,
      }));
      const profileItems = profileNames(state.currentConfig)
        .filter((name) => name.startsWith(token))
        .map((name) => ({ value: name, label: `router/${name}` }));
      const items = [...pinItems, ...profileItems];
      return items.length > 0 ? items : null;
    }

    const profileToken = args[0];
    if (!state.currentConfig.profiles[profileToken]) {
      return null;
    }
    const pinPrefix = args[1] ?? '';
    const items = ROUTER_PIN_VALUES.filter((value) =>
      value.startsWith(pinPrefix),
    ).map((value) => ({
      value: `${profileToken} ${value}`,
      label: `${profileToken} ${value}`,
    }));
    return items.length > 0 ? items : null;
  };

  const getThinkingCompletions = (
    args: string[],
  ): CommandCompletionItem[] | null => {
    // thinking [profile] [tier] <level|auto>
    const tierValues = [...ROUTER_TIERS];
    const levelValues = ['auto', ...THINKING_LEVELS];

    if (args.length <= 1) {
      const token = args[0] ?? '';
      return [
        ...levelValues
          .filter((v) => v.startsWith(token))
          .map((v) => ({ value: v, label: v })),
        ...tierValues
          .filter((v) => v.startsWith(token))
          .map((v) => ({ value: v, label: v })),
        ...profileNames(state.currentConfig)
          .filter((name) => name.startsWith(token))
          .map((name) => ({ value: name, label: `router/${name}` })),
      ];
    }

    if (levelValues.includes(args[0])) {
      return null;
    }

    if (tierValues.includes(args[0])) {
      const tier = args[0];
      const levelPrefix = args[1] ?? '';
      return levelValues
        .filter((v) => v.startsWith(levelPrefix))
        .map((v) => ({ value: `${tier} ${v}`, label: `${tier} ${v}` }));
    }

    if (state.currentConfig.profiles[args[0]]) {
      const profile = args[0];
      const nextPrefix = args[1] ?? '';

      if (args.length === 2) {
        return [
          ...tierValues
            .filter((v) => v.startsWith(nextPrefix))
            .map((v) => ({ value: `${profile} ${v}`, label: v })),
          ...levelValues
            .filter((v) => v.startsWith(nextPrefix))
            .map((v) => ({ value: `${profile} ${v}`, label: v })),
        ];
      }

      if (levelValues.includes(args[1])) {
        return null;
      }

      if (tierValues.includes(args[1])) {
        const tier = args[1];
        const levelPrefix = args[2] ?? '';
        return levelValues
          .filter((v) => v.startsWith(levelPrefix))
          .map((v) => ({ value: `${profile} ${tier} ${v}`, label: v }));
      }
    }

    return null;
  };

  const handleStatus = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 0) {
      ctx.ui.notify('Usage: /router status (no arguments)', 'error');
      return;
    }
    const names = profileNames(state.currentConfig).join(', ');
    const lines = [
      'Model Router Status:',
      `Router enabled: ${state.routerEnabled ? 'yes' : 'off'}`,
      `Selected profile: ${state.selectedProfile}`,
      `Selected profile pin: ${state.pinnedTierByProfile[state.selectedProfile] ?? 'auto'}`,
      `Pins by profile: ${formatPinSummary(state.pinnedTierByProfile)}`,
      `Thinking overrides: ${formatThinkingSummary(state.thinkingByProfile)}`,
      `Widget: ${state.widgetEnabled ? 'on' : 'off'}`,
      `Phase bias: ${state.currentConfig.phaseBias}`,
      `Session cost: $${state.accumulatedCost.toFixed(4)}` +
        (state.currentConfig.maxSessionBudget
          ? ` / $${state.currentConfig.maxSessionBudget.toFixed(2)}`
          : ''),
      `Default profile: ${resolveProfileName(state.currentConfig, state.currentConfig.defaultProfile)}`,
      `Available profiles: ${names}`,
      `Last non-router model: ${formatModelRef(state.lastNonRouterModel)}`,
      `Debug: ${state.debugEnabled ? 'on' : 'off'}`,
      `Debug history: ${state.debugHistory.length} decisions`,
    ];
    if (state.lastDecision) {
      lines.push(
        `Last routed tier: ${state.lastDecision.tier}`,
        `Last phase: ${state.lastDecision.phase}`,
        `Last model: ${state.lastDecision.targetProvider}/${state.lastDecision.targetModelId} (${state.lastDecision.thinking})`,
        `Reason: ${state.lastDecision.reasoning}`,
      );
    }
    ctx.ui.notify(lines.join('\n'), 'info');
    actions.updateStatus(ctx);
  };

  const handleProfile = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 1) {
      ctx.ui.notify('Usage: /router profile [name]', 'error');
      return;
    }
    const profileName = args[0];
    if (!profileName) {
      ctx.ui.notify(
        `Current profile: ${state.selectedProfile}. Available: ${profileNames(state.currentConfig).join(', ')}`,
        'info',
      );
      return;
    }
    const success = await actions.switchToRouterProfile(profileName, ctx);
    if (success) {
      ctx.ui.notify(
        `Switched to router profile: ${state.selectedProfile}`,
        'info',
      );
    }
  };

  const handlePin = async (args: string[], ctx: ExtensionContext) => {
    const currentProfile = state.selectedProfile;
    if (args.length === 0) {
      ctx.ui.notify(
        [
          `Profile: ${currentProfile}`,
          `Pinned tier: ${state.pinnedTierByProfile[currentProfile] ?? 'auto'}`,
          `Pins by profile: ${formatPinSummary(state.pinnedTierByProfile)}`,
          `Usage: /router pin <high|medium|low|auto>`,
          `   or: /router pin <profile> <high|medium|low|auto>`,
        ].join('\n'),
        'info',
      );
      actions.updateStatus(ctx);
      return;
    }

    if (args.length > 2) {
      ctx.ui.notify(
        'Usage: /router pin [profile] <high|medium|low|auto>',
        'error',
      );
      return;
    }

    let profileName = currentProfile;
    let pinValue = '';

    if (args.length === 1) {
      pinValue = args[0];
    } else {
      profileName = args[0];
      pinValue = args[1];
    }

    if (!state.currentConfig.profiles[profileName]) {
      // If we had two args and the first wasn't a profile, it's definitely an error
      if (args.length === 2) {
        ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        return;
      }
      // If one arg, maybe they meant the pin value for the current profile
      if (ROUTER_PIN_VALUES.includes(args[0] as any)) {
        profileName = currentProfile;
        pinValue = args[0];
      } else {
        ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        return;
      }
    }

    if (!ROUTER_PIN_VALUES.includes(pinValue as any)) {
      ctx.ui.notify(
        `Invalid router pin: ${pinValue}. Use one of: ${ROUTER_PIN_VALUES.join(', ')}`,
        'error',
      );
      return;
    }

    const nextTier = pinValue === 'auto' ? undefined : (pinValue as RouterTier);
    if (nextTier) {
      state.pinnedTierByProfile[profileName] = nextTier;
    } else {
      delete state.pinnedTierByProfile[profileName];
    }
    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(
      nextTier
        ? `Router profile ${profileName} pinned to ${nextTier}`
        : `Router profile ${profileName} pin cleared; heuristic routing restored`,
      'info',
    );
  };

  const handleThinking = async (args: string[], ctx: ExtensionContext) => {
    const currentProfile = state.selectedProfile;
    if (args.length === 0) {
      ctx.ui.notify(
        [
          `Profile: ${currentProfile}`,
          `Thinking overrides: ${JSON.stringify(state.thinkingByProfile[currentProfile] ?? {})}`,
          'Usage: /router thinking <level|auto>',
          '   or: /router thinking <tier> <level|auto>',
          '   or: /router thinking <profile> <tier> <level|auto>',
        ].join('\n'),
        'info',
      );
      return;
    }

    if (args.length > 3) {
      ctx.ui.notify('Too many arguments for /router thinking.', 'error');
      return;
    }

    let profileName = currentProfile;
    let tier: RouterTier | 'all' | undefined = undefined;
    let levelValue = '';

    const tierValues = ['high', 'medium', 'low'];
    const levelValues = ['auto', ...THINKING_LEVELS];

    if (args.length === 1) {
      levelValue = args[0];
      tier =
        state.pinnedTierByProfile[profileName] ??
        (state.lastDecision?.profile === profileName
          ? state.lastDecision.tier
          : 'medium');
    } else if (args.length === 2) {
      if (tierValues.includes(args[0]) || args[0] === 'all') {
        tier = args[0] as RouterTier | 'all';
        levelValue = args[1];
      } else {
        profileName = args[0];
        levelValue = args[1];
        tier =
          state.pinnedTierByProfile[profileName] ??
          (state.lastDecision?.profile === profileName
            ? state.lastDecision.tier
            : 'medium');
      }
    } else if (args.length === 3) {
      profileName = args[0];
      tier = args[1] as RouterTier | 'all';
      levelValue = args[2];
    }

    if (!state.currentConfig.profiles[profileName]) {
      ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
      return;
    }
    if (tier !== 'all' && !tierValues.includes(tier as string)) {
      ctx.ui.notify(
        `Invalid tier: ${tier}. Use high, medium, or low.`,
        'error',
      );
      return;
    }
    if (!levelValues.includes(levelValue)) {
      ctx.ui.notify(
        `Invalid thinking level: ${levelValue}. Use auto or: ${THINKING_LEVELS.join(', ')}`,
        'error',
      );
      return;
    }

    const nextLevel = levelValue === 'auto' ? undefined : (levelValue as any);
    if (tier === 'all') {
      for (const t of ROUTER_TIERS) {
        if (!state.thinkingByProfile[profileName])
          state.thinkingByProfile[profileName] = {};
        if (nextLevel) state.thinkingByProfile[profileName]![t] = nextLevel;
        else delete state.thinkingByProfile[profileName]![t];
      }
    } else {
      if (!state.thinkingByProfile[profileName])
        state.thinkingByProfile[profileName] = {};
      if (nextLevel)
        state.thinkingByProfile[profileName]![tier as RouterTier] = nextLevel;
      else delete state.thinkingByProfile[profileName]![tier as RouterTier];
    }
    if (
      state.thinkingByProfile[profileName] &&
      Object.keys(state.thinkingByProfile[profileName]!).length === 0
    ) {
      delete state.thinkingByProfile[profileName];
    }

    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(
      nextLevel
        ? `Router profile ${profileName} thinking (${tier}) set to ${nextLevel}`
        : `Router profile ${profileName} thinking (${tier}) reset to config defaults`,
      'info',
    );
  };

  const handleDisable = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 0) {
      ctx.ui.notify('Usage: /router disable (no arguments)', 'error');
      return;
    }
    if (!state.lastNonRouterModel) {
      ctx.ui.notify(
        'No previous non-router model recorded. Use /model to pick a concrete model.',
        'warning',
      );
      return;
    }
    const { provider, modelId } = parseCanonicalModelRef(
      state.lastNonRouterModel,
    );
    const targetModel = ctx.modelRegistry.find(provider, modelId);
    if (!targetModel) {
      ctx.ui.notify(
        `Recorded non-router model is unavailable: ${state.lastNonRouterModel}`,
        'error',
      );
      return;
    }
    const success = await pi.setModel(targetModel);
    if (!success) {
      ctx.ui.notify(`Failed to switch to ${state.lastNonRouterModel}`, 'error');
      return;
    }
    state.routerEnabled = false;
    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(
      `Router disabled. Restored ${state.lastNonRouterModel}`,
      'info',
    );
  };

  const handleFix = async (args: string[], ctx: ExtensionContext) => {
    if (args.length !== 1) {
      ctx.ui.notify('Usage: /router fix <high|medium|low>', 'error');
      return;
    }
    const tier = args[0]?.toLowerCase();
    if (!ROUTER_TIERS.includes(tier as RouterTier)) {
      ctx.ui.notify('Usage: /router fix <high|medium|low>', 'error');
      return;
    }
    if (!state.lastDecision) {
      ctx.ui.notify('No recent routing decision to fix.', 'warning');
      return;
    }
    state.pinnedTierByProfile[state.lastDecision.profile] = tier as RouterTier;
    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(
      `Router decision corrected. ${state.lastDecision.profile} is now pinned to ${tier}.`,
      'info',
    );
  };

  const handleWidget = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 1) {
      ctx.ui.notify('Usage: /router widget <on|off|toggle>', 'error');
      return;
    }
    const cmd = args[0]?.toLowerCase();
    if (cmd === 'on') state.widgetEnabled = true;
    else if (cmd === 'off') state.widgetEnabled = false;
    else state.widgetEnabled = !state.widgetEnabled;
    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(
      `Router widget ${state.widgetEnabled ? 'enabled' : 'disabled'}.`,
      'info',
    );
  };

  const handleDebug = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 1) {
      ctx.ui.notify('Usage: /router debug <on|off|show|clear>', 'error');
      return;
    }
    const cmd = args[0]?.toLowerCase();
    if (cmd === 'on') state.debugEnabled = true;
    else if (cmd === 'off') state.debugEnabled = false;
    else if (cmd === 'clear') state.debugHistory.length = 0;
    else if (cmd === 'show') {
      if (state.debugHistory.length === 0) {
        ctx.ui.notify('No recent routing decisions.', 'info');
      } else {
        const history = state.debugHistory
          .map(
            (d) =>
              `[${new Date(d.timestamp).toLocaleTimeString()}] ${formatDecision(d)}`,
          )
          .join('\n');
        ctx.ui.notify(`Recent Routing Decisions:\n${history}`, 'info');
      }
      return;
    } else {
      state.debugEnabled = !state.debugEnabled;
    }
    actions.persistState();
    ctx.ui.notify(
      `Router debug ${state.debugEnabled ? 'enabled' : 'disabled'}.`,
      'info',
    );
  };

  const handleReload = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 0) {
      ctx.ui.notify('Usage: /router reload (no arguments)', 'error');
      return;
    }
    actions.reloadConfig(ctx, { preserveDebug: true });
    await actions.ensureValidActiveRouterProfile(ctx);
    ctx.ui.notify(
      `Router config reloaded. Profiles: ${profileNames(state.currentConfig).join(', ')}`,
      'info',
    );
  };

  pi.registerCommand('router', {
    description: 'Model router control center',
    getArgumentCompletions: (prefix) => {
      const trimmedLeft = prefix.trimStart();
      const hasTrailingSpace = /\s$/.test(prefix);
      const parts = trimmedLeft.length > 0 ? trimmedLeft.split(/\s+/) : [];

      if (parts.length === 0) {
        return getSubcommandCompletions('');
      }

      if (parts.length === 1 && !hasTrailingSpace) {
        return getSubcommandCompletions(parts[0]);
      }

      const subcommand = parts[0];
      const subArgs = parts.slice(1);
      if (hasTrailingSpace && parts.length === 1) {
        subArgs.push('');
      }

      switch (subcommand) {
        case 'profile': {
          const profilePrefix = subArgs[0] ?? '';
          const items = profileNames(state.currentConfig)
            .filter((name) => name.startsWith(profilePrefix))
            .map((name) => ({
              value: `profile ${name}`,
              label: `router/${name}`,
              description: `Switch to router profile "${name}"`,
            }));
          return items.length > 0 ? items : null;
        }
        case 'pin': {
          const completions = getPinCompletions(subArgs);
          return (
            completions?.map((c) => ({
              ...c,
              value: `pin ${c.value}`,
              description: `Pin profile to ${c.label}`,
            })) ?? null
          );
        }
        case 'thinking': {
          const completions = getThinkingCompletions(subArgs);
          return (
            completions?.map((c) => ({
              ...c,
              value: `thinking ${c.value}`,
              description: `Set thinking level to ${c.label}`,
            })) ?? null
          );
        }
        case 'fix': {
          const fixPrefix = subArgs[0] ?? '';
          const items = ['high', 'medium', 'low']
            .filter((t) => t.startsWith(fixPrefix.toLowerCase()))
            .map((t) => ({
              value: `fix ${t}`,
              label: t,
              description: `Correct decision and pin to ${t} tier`,
            }));
          return items.length > 0 ? items : null;
        }
        case 'widget': {
          const widgetPrefix = subArgs[0] ?? '';
          const items = ['on', 'off', 'toggle']
            .filter((v) => v.startsWith(widgetPrefix))
            .map((v) => ({
              value: `widget ${v}`,
              label: v,
              description: `Set widget to ${v}`,
            }));
          return items.length > 0 ? items : null;
        }
        case 'debug': {
          const debugPrefix = subArgs[0] ?? '';
          const items = ['on', 'off', 'toggle', 'clear', 'show']
            .filter((v) => v.startsWith(debugPrefix))
            .map((v) => ({
              value: `debug ${v}`,
              label: v,
              description: `Router debug: ${v}`,
            }));
          return items.length > 0 ? items : null;
        }
      }

      return null;
    },
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) ?? [];
      const subcommand = parts[0];
      const subArgs = parts.slice(1);

      switch (subcommand) {
        case 'profile':
          await handleProfile(subArgs, ctx);
          break;
        case 'pin':
          await handlePin(subArgs, ctx);
          break;
        case 'thinking':
          await handleThinking(subArgs, ctx);
          break;
        case 'disable':
          await handleDisable(subArgs, ctx);
          break;
        case 'fix':
          await handleFix(subArgs, ctx);
          break;
        case 'widget':
          await handleWidget(subArgs, ctx);
          break;
        case 'debug':
          await handleDebug(subArgs, ctx);
          break;
        case 'reload':
          await handleReload(subArgs, ctx);
          break;
        case 'status':
          await handleStatus(subArgs, ctx);
          break;
        case 'help':
        case '?':
          if (subArgs.length > 0) {
            ctx.ui.notify('Usage: /router help (no arguments)', 'error');
            return;
          }
          ctx.ui.notify(
            [
              'Router Subcommands:',
              '  status                      Show current status, profile, pin, cost, and last decision.',
              '  profile [name]              Switch to a profile (enables router if off). Lists available if no name.',
              '  pin [profile] <tier|auto>   Force a tier (high|medium|low) for a profile or set to auto.',
              '  thinking [prof] [tier] <lv> Override thinking level for a profile/tier (off|minimal|...|xhigh|auto).',
              '  disable                     Disable the router and restore the last used non-router model.',
              '  fix <tier>                  Correct the last routing decision and pin that tier for the current profile.',
              '  widget <on|off|toggle>      Control the persistent status widget visibility.',
              '  debug <on|off|show|clear>   Control routing debug logging to notifications and history.',
              '  reload                      Hot-reload the configuration JSON from .pi/model-router.json.',
              '  help, ?                     Show this help message.',
            ].join('\n'),
            'info',
          );
          break;
        default:
          if (subcommand) {
            // Check if subcommand is actually a profile name (backwards compatible-ish with /router-on)
            if (state.currentConfig.profiles[subcommand]) {
              if (subArgs.length > 0) {
                ctx.ui.notify(
                  `Usage: /router ${subcommand} (no extra arguments allowed)`,
                  'error',
                );
                return;
              }
              await actions.switchToRouterProfile(subcommand, ctx);
              ctx.ui.notify(
                `Router enabled with profile: ${state.selectedProfile}`,
                'info',
              );
            } else {
              ctx.ui.notify(
                `Unknown router subcommand: ${subcommand}. Try /router help`,
                'error',
              );
            }
          } else {
            await handleStatus(subArgs, ctx);
          }
          break;
      }
    },
  });
};
