import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type {
  RoutingDecision,
  RouterConfig,
  RouterPinByProfile,
  RouterThinkingByProfile,
} from './types';

const getEffectiveThinking = (
  thinkingByProfile: RouterThinkingByProfile,
  profileName: string,
  decision: RoutingDecision,
) => thinkingByProfile[profileName]?.[decision.tier] ?? decision.thinking;

const getDecisionFlags = (decision: RoutingDecision): string[] => {
  const flags: string[] = [];
  if (decision.isFallback) flags.push('fallback');
  if (decision.isContextTriggered) flags.push('context');
  if (decision.isBudgetForced) flags.push('budget-limit');
  if (decision.isRuleMatched) flags.push('rule');
  return flags;
};

export const formatDecision = (decision: RoutingDecision): string => {
  return `${decision.profile}: ${decision.tier} -> ${decision.targetProvider}/${decision.targetModelId} [${decision.thinking}] (${decision.reasoning})`;
};

export const formatPinSummary = (
  pinnedTierByProfile: RouterPinByProfile,
): string => {
  const entries = Object.entries(pinnedTierByProfile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([profile, tier]) => `${profile}:${tier}`);
  return entries.length > 0 ? entries.join(', ') : 'none';
};

export const formatThinkingSummary = (
  thinkingByProfile: RouterThinkingByProfile,
): string => {
  const entries = Object.entries(thinkingByProfile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([profile, tierMap]) => {
      const tiers = Object.entries(tierMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tier, level]) => `${tier}:${level}`);
      return `${profile}(${tiers.join(',')})`;
    });
  return entries.length > 0 ? entries.join(', ') : 'none';
};

export const formatModelRef = (ref: string | undefined): string => {
  return ref ?? 'none';
};

export const updateStatus = (
  ctx: ExtensionContext,
  routerEnabled: boolean,
  selectedProfile: string,
  pinnedTierByProfile: RouterPinByProfile,
  thinkingByProfile: RouterThinkingByProfile,
  lastDecision: RoutingDecision | undefined,
  lastNonRouterModel: string | undefined,
  accumulatedCost: number,
  widgetEnabled: boolean,
  currentConfig: RouterConfig,
) => {
  const activeRouterProfile = routerEnabled ? selectedProfile : undefined;
  const statusProfile = selectedProfile;
  const activePin = pinnedTierByProfile[statusProfile];
  const pinLabel = activePin ? ` [pin:${activePin}]` : '';

  let statusText: string;
  if (activeRouterProfile) {
    const matchesProfile =
      lastDecision && lastDecision.profile === activeRouterProfile;
    const matchesPin = activePin ? lastDecision?.tier === activePin : true;

    if (lastDecision && matchesProfile && matchesPin) {
      const effectiveThinking = getEffectiveThinking(
        thinkingByProfile,
        activeRouterProfile,
        lastDecision,
      );
      statusText = `router:${activeRouterProfile}${pinLabel} -> ${lastDecision.tier} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${effectiveThinking})`;
    } else {
      statusText = `router:${activeRouterProfile}${pinLabel} -> waiting`;
    }
  } else {
    statusText = `router:off (${selectedProfile}${pinLabel}) -> ${formatModelRef(lastNonRouterModel)}`;
  }
  ctx.ui.setStatus('router', ctx.ui.theme.fg('dim', statusText));

  if (!widgetEnabled) {
    ctx.ui.setWidget('router', undefined);
    return;
  }

  const widgetLines = [
    `Router: ${routerEnabled ? 'enabled' : 'disabled'}`,
    `Profile: ${statusProfile}${activeRouterProfile ? ' (active)' : ''}`,
    `Pin: ${activePin ?? 'auto'}`,
    `Cost: $${accumulatedCost.toFixed(4)}` +
      (currentConfig.maxSessionBudget
        ? ` / $${currentConfig.maxSessionBudget.toFixed(2)}`
        : ''),
  ];
  if (lastDecision && lastDecision.profile === statusProfile) {
    const effectiveThinking = getEffectiveThinking(
      thinkingByProfile,
      statusProfile,
      lastDecision,
    );
    const flags = getDecisionFlags(lastDecision);
    const flagsStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';

    widgetLines.push(
      `Route: ${lastDecision.tier}${flagsStr} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${effectiveThinking})`,
      `Phase: ${lastDecision.phase}`,
    );
  } else if (!routerEnabled && lastNonRouterModel) {
    widgetLines.push(`Fallback: ${lastNonRouterModel}`);
  }
  if (Object.keys(pinnedTierByProfile).length > 1) {
    widgetLines.push(`Pins: ${formatPinSummary(pinnedTierByProfile)}`);
  }
  ctx.ui.setWidget(
    'router',
    widgetLines.map((line) => ctx.ui.theme.fg('dim', line)),
  );
};
