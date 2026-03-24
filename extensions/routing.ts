import { streamSimple, type Context, type Message } from '@mariozechner/pi-ai';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type {
  RouterTier,
  RouterPhase,
  RouterProfile,
  RoutingDecision,
  RoutingRule,
  RouterThinkingByTier,
} from './types';
import { parseCanonicalModelRef, isRouterTier } from './config';

export const extractTextFromContent = (
  content: string | Message['content'],
): string => {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'thinking') return part.thinking;
      if (part.type === 'toolCall')
        return `${part.name} ${JSON.stringify(part.arguments)}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

export const getLastUserText = (context: Context): string => {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message.role === 'user') {
      return extractTextFromContent(message.content).trim();
    }
  }
  return '';
};

export const getRecentConversationText = (
  context: Context,
  limit = 6,
): string => {
  return context.messages
    .slice(-limit)
    .map((message) => extractTextFromContent(message.content).trim())
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
};

export const countToolResults = (context: Context): number => {
  return context.messages.filter((message) => message.role === 'toolResult')
    .length;
};

export const countWords = (text: string): number => {
  return text.split(/\s+/).filter(Boolean).length;
};

export const hasImageAttachment = (context: Context): boolean => {
  return context.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image'),
  );
};

export const containsAny = (text: string, keywords: string[]): boolean => {
  return keywords.some((keyword) => text.includes(keyword));
};

export const phaseForTier = (tier: RouterTier): RouterPhase => {
  if (tier === 'high') return 'planning';
  if (tier === 'medium') return 'implementation';
  return 'lightweight';
};

export const buildRoutingDecision = (
  profileName: string,
  profile: RouterProfile,
  tier: RouterTier,
  phase: RouterPhase,
  reasoning: string,
  thinkingOverrides?: RouterThinkingByTier,
  isClassifier?: boolean,
): RoutingDecision => {
  const routed = profile[tier];
  const { provider, modelId } = parseCanonicalModelRef(routed.model);
  const baseThinking =
    routed.thinking ??
    (tier === 'high' ? 'high' : tier === 'low' ? 'low' : 'medium');
  const effectiveThinking = thinkingOverrides?.[tier] ?? baseThinking;

  return {
    profile: profileName,
    tier,
    phase,
    targetProvider: provider,
    targetModelId: modelId,
    targetLabel: routed.model,
    reasoning,
    thinking: effectiveThinking,
    timestamp: Date.now(),
    isClassifier,
  };
};

export const decideRouting = (
  context: Context,
  profileName: string,
  profile: RouterProfile,
  previousDecision: RoutingDecision | undefined,
  pinnedTier?: RouterTier,
  thinkingOverrides?: RouterThinkingByTier,
  phaseBias = 0.5,
  rules?: RoutingRule[],
  isBudgetExceeded = false,
): RoutingDecision => {
  const prompt = getLastUserText(context).toLowerCase();
  const recentConversation = getRecentConversationText(context);
  const toolResultCount = countToolResults(context);
  const wordCount = countWords(prompt);
  const multiLinePrompt = prompt.split('\n').length >= 4;

  const explicitHighHints = [
    'best',
    'deep',
    'deeply',
    'carefully',
    'thoroughly',
    'robust',
    'comprehensive',
    'step by step',
    'think hard',
    'highest quality',
  ];
  const explicitLowHints = [
    'fast',
    'cheap',
    'quick',
    'quickly',
    'brief',
    'briefly',
    'one sentence',
    'one line',
    'tiny',
    'small',
  ];
  const planningKeywords = [
    'plan',
    'planning',
    'architecture',
    'architect',
    'design',
    'tradeoff',
    'trade-off',
    'research',
    'investigate',
    'root cause',
    'analyze',
    'analysis',
    'migration',
    'strategy',
    'compare',
    'options',
    'approach',
  ];
  const summaryKeywords = [
    'summarize',
    'summary',
    'changelog',
    'rewrite',
    'reformat',
    'format',
    'rename',
    'explain briefly',
    'recap',
    'tl;dr',
  ];
  const implementationKeywords = [
    'implement',
    'code',
    'fix',
    'update',
    'edit',
    'write',
    'refactor',
    'add tests',
    'patch',
    'change',
    'apply',
    'continue',
    'resume',
    'make the changes',
    'go ahead',
  ];
  const lookupKeywords = [
    'where is',
    'which file',
    'show me',
    'list',
    'what files',
    'find',
    'grep',
  ];

  let phase: RouterPhase = previousDecision?.phase ?? 'implementation';
  let tier: RouterTier = 'medium';
  let reasoning = 'Defaulted to medium tier for general coding work.';
  let isRuleMatched = false;

  if (pinnedTier) {
    phase = phaseForTier(pinnedTier);
    tier = pinnedTier;
    reasoning = `Pinned to ${pinnedTier} tier via /router-pin.`;
  } else {
    // Check custom rules first
    if (rules) {
      for (const rule of rules) {
        const matches = Array.isArray(rule.matches)
          ? rule.matches
          : [rule.matches];
        if (containsAny(prompt, matches)) {
          tier = rule.tier;
          phase = phaseForTier(tier);
          reasoning =
            rule.reason ??
            `Matched custom routing rule for: ${matches.join(', ')}`;
          isRuleMatched = true;
          break;
        }
      }
    }

    if (!isRuleMatched) {
      // Sticky phase adjustments
      const highThreshold = Math.max(
        40,
        120 - (previousDecision?.phase === 'planning' ? phaseBias * 80 : 0),
      );
      const lowThreshold = Math.max(
        4,
        12 -
          (previousDecision?.phase === 'implementation' ||
          previousDecision?.phase === 'planning'
            ? phaseBias * 8
            : 0),
      );

      if (containsAny(prompt, explicitHighHints)) {
        phase = 'planning';
        tier = 'high';
        reasoning =
          'Detected an explicit request for deeper or higher-quality reasoning.';
      } else if (containsAny(prompt, explicitLowHints)) {
        phase = 'lightweight';
        tier = 'low';
        reasoning =
          'Detected an explicit request for a faster or lighter response.';
      } else if (containsAny(prompt, summaryKeywords)) {
        phase = 'lightweight';
        tier = 'low';
        reasoning = 'Detected summary or lightweight transformation keywords.';
      } else if (
        containsAny(prompt, planningKeywords) ||
        prompt.startsWith('why ') ||
        wordCount >= highThreshold ||
        multiLinePrompt
      ) {
        phase = 'planning';
        tier = 'high';
        reasoning =
          previousDecision?.phase === 'planning'
            ? 'Continued planning phase based on complexity or keywords.'
            : 'Detected planning, broad analysis, or a high-complexity request.';
      } else if (containsAny(prompt, implementationKeywords)) {
        phase = 'implementation';
        tier = 'medium';
        reasoning =
          'Detected implementation-oriented work with bounded execution scope.';
      } else if (
        containsAny(prompt, lookupKeywords) &&
        wordCount <= 24 &&
        toolResultCount === 0
      ) {
        phase = 'lightweight';
        tier = 'low';
        reasoning = 'Detected a short read-only lookup request.';
      } else if (
        previousDecision?.phase === 'planning' &&
        toolResultCount === 0 &&
        wordCount > lowThreshold
      ) {
        phase = 'planning';
        tier = 'high';
        reasoning =
          'Kept the planning-phase bias because the conversation still looks exploratory.';
      } else if (
        toolResultCount > 0 ||
        previousDecision?.phase === 'implementation' ||
        recentConversation.includes('plan:')
      ) {
        phase = 'implementation';
        tier = 'medium';
        reasoning =
          'Detected active implementation work from prior tools or recent plan execution context.';
      } else if (wordCount <= lowThreshold) {
        phase = 'lightweight';
        tier = 'low';
        reasoning = 'Detected a short bounded request.';
      }
    }
  }

  let isBudgetForced = false;
  if (isBudgetExceeded && tier === 'high') {
    tier = 'medium';
    phase = 'implementation';
    reasoning = `Budget exceeded. Downgraded from high to medium tier. (Original: ${reasoning})`;
    isBudgetForced = true;
  }

  const decision = buildRoutingDecision(
    profileName,
    profile,
    tier,
    phase,
    reasoning,
    thinkingOverrides,
    false,
  );
  decision.isRuleMatched = isRuleMatched;
  decision.isBudgetForced = isBudgetForced;
  return decision;
};

export const runClassifier = async (
  classifierModelRef: string,
  modelRegistry: ExtensionContext['modelRegistry'],
  context: Context,
  currentPhase?: RouterPhase,
): Promise<{ tier: RouterTier; reasoning: string } | undefined> => {
  try {
    const { provider, modelId } = parseCanonicalModelRef(classifierModelRef);
    const model = modelRegistry.find(provider, modelId);
    if (!model) return undefined;

    const apiKey = await modelRegistry.getApiKey(model);
    if (!apiKey) return undefined;

    const promptText = getLastUserText(context);
    const historyText = getRecentConversationText(context, 4);

    const classifierPrompt = `You are a model router classifier. Your job is to categorize the user's latest request into one of three tiers: "high", "medium", or "low".

Tiers:
- high: Architecture, design, planning, tradeoff analysis, broad debugging, large refactors, codebase research.
- medium: Implementation of a known plan, multi-file edits, normal coding work, focused debugging, tests/fixes.
- low: Summaries, changelogs, formatting, quick explanations, small bounded transforms, simple read-only lookup.

${currentPhase ? `Current conversation phase: ${currentPhase}\n` : ''}
Recent history:
${historyText}

Latest user message:
${promptText}

Return your decision in exactly two lines:
Tier: [high|medium|low]
Reasoning: [one short sentence]

${currentPhase === 'planning' ? 'Consider that the conversation is currently in a planning phase. Bias toward "high" unless the request is clearly a simple implementation or summary.' : ''}
${currentPhase === 'implementation' ? 'Consider that the conversation is currently in an implementation phase. Bias toward "medium" unless the request is clearly planning or a simple summary.' : ''}`;

    const classifierContext: Context = {
      ...context,
      messages: [{ role: 'user', content: classifierPrompt }],
    };

    const stream = streamSimple(model, classifierContext, { apiKey });
    let fullText = '';
    for await (const event of stream) {
      if (
        event.type === 'chunk' &&
        typeof (event as any).content === 'string'
      ) {
        fullText += (event as any).content;
      } else if (
        event.type === 'text_delta' &&
        typeof (event as any).delta === 'string'
      ) {
        fullText += (event as any).delta;
      }
    }

    const lines = fullText.trim().split('\n');
    const tierLine = lines.find((l) => l.toLowerCase().startsWith('tier:'));
    const reasoningLine = lines.find((l) =>
      l.toLowerCase().startsWith('reasoning:'),
    );

    if (tierLine) {
      const tierValue = tierLine.split(':')[1].trim().toLowerCase();
      if (isRouterTier(tierValue)) {
        return {
          tier: tierValue,
          reasoning: reasoningLine
            ? reasoningLine.split(':')[1].trim()
            : 'Classifier decision.',
        };
      }
    }
  } catch (error) {
    // Ignore classifier errors and fall back to heuristics
  }
  return undefined;
};
