import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  streamSimple,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RouterConfig, RouterPinByProfile, RouterThinkingByProfile, RouterTier, RoutingDecision } from './types';
import { parseCanonicalModelRef, profileNames, ROUTER_TIERS } from './config';
import {
  buildRoutingDecision,
  countConsecutiveRecentToolFailures,
  countToolResultsSinceLastUserPrompt,
  decideRouting,
  extractTextFromContent,
  phaseForTier,
  runClassifier,
} from './routing';

export const createErrorMessage = (model: Model<Api>, message: string): AssistantMessage => {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  };
};

/**
 * Heuristic token estimator (conservative: 3 characters per token)
 */
const estimateTokens = (text: string): number => Math.ceil(text.length / 3);

/**
 * Truncate context to fit within a target token limit by removing oldest messages.
 * Always preserves the first system message and the latest user message.
 */
const truncateContext = (context: Context, limit: number): Context => {
  const messages = [...context.messages];
  if (messages.length <= 1) return context;

  const getSystemTokens = () => (context.systemPrompt ? estimateTokens(context.systemPrompt) : 0);

  // Initial estimate
  const totalTokens =
    getSystemTokens() + messages.reduce((sum, m) => sum + estimateTokens(extractTextFromContent(m.content)), 0);
  if (totalTokens <= limit) return context;

  const latestMessage = messages.pop();
  if (!latestMessage) return context;

  // Remove oldest until it fits
  while (messages.length > 0) {
    const currentTokens =
      getSystemTokens() +
      estimateTokens(extractTextFromContent(latestMessage.content)) +
      messages.reduce((sum, m) => sum + estimateTokens(extractTextFromContent(m.content)), 0);

    if (currentTokens <= limit) break;
    messages.shift(); // Remove oldest
  }

  const finalMessages: Message[] = [];
  finalMessages.push(...messages);
  finalMessages.push(latestMessage);

  return { ...context, messages: finalMessages };
};

const supportsReasoning = (
  profile: RouterConfig['profiles'][string],
  modelRegistry: ExtensionContext['modelRegistry'] | undefined,
): boolean => {
  if (!modelRegistry) return false;

  for (const tier of ROUTER_TIERS) {
    try {
      const { provider, modelId } = parseCanonicalModelRef(profile[tier].model);
      if (modelRegistry.find(provider, modelId)?.reasoning) {
        return true;
      }
    } catch (_error) {
      // ignore invalid model refs here; config normalization handles warnings
    }
  }

  return false;
};

const imageDetectedInRecentContext = (context: Context): boolean => {
  // Only check the last 6 messages (typically covers the last 3 full turns (3 user messages and 3 assistant responses)
  // to detect images relevant to the current turn. This covers: direct user uploads, tool results from screenshot reads,
  // and assistant messages with images - without firing on stale images from many turns ago.
  const recentMessages = context.messages.slice(-6);
  return recentMessages.some(
    (message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image'),
  );
};

export const registerRouterProvider = (
  pi: ExtensionAPI,
  state: {
    lastRegisteredModels: string;
    readonly currentConfig: RouterConfig;
    readonly currentModelRegistry: ExtensionContext['modelRegistry'] | undefined;
    readonly lastExtensionContext: ExtensionContext | undefined;
    selectedProfile: string;
    routerEnabled: boolean;
    lastDecision: RoutingDecision | undefined;
    readonly thinkingByProfile: RouterThinkingByProfile;
    readonly pinnedTierByProfile: RouterPinByProfile;
    accumulatedCost: number;
    debugEnabled: boolean;
  },
  actions: {
    persistState: () => void;
    recordDebugDecision: (decision: RoutingDecision) => void;
    getThinkingOverride: (profileName: string, tier: RouterTier) => any;
    updateStatus: (ctx: ExtensionContext) => void;
  },
) => {
  const currentConfig = state.currentConfig;

  // Map profiles to their capacities
  const modelDefinitions = profileNames(currentConfig).map((name) => {
    const profile = currentConfig.profiles[name];
    let contextWindow = 1_000_000;
    let maxTokens = 64_000;

    if (state.currentModelRegistry) {
      for (const tier of ROUTER_TIERS) {
        try {
          const { provider, modelId } = parseCanonicalModelRef(
            profile[tier].model,
          );
          const tierModel = state.currentModelRegistry.find(provider, modelId);
          if (tierModel) {
            if (tier === 'high') {
              contextWindow = tierModel.contextWindow ?? contextWindow;
              maxTokens = tierModel.maxTokens ?? maxTokens;
            }
          }
        } catch (_error) {
          // ignore
        }
      }
    }

    return {
      id: name,
      name: `Router ${name}`,
      reasoning: supportsReasoning(profile, state.currentModelRegistry),
      input: ['text', 'image'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    };
  });

  const modelsKey = modelDefinitions
    .map((m) => `${m.id}:${m.contextWindow}:${m.maxTokens}:${m.reasoning}`)
    .join(',');
  if (state.lastRegisteredModels === modelsKey) return;

  pi.registerProvider('router', {
    baseUrl: 'router://local',
    apiKey: 'pi-model-router',
    api: 'router-local-api',
    models: modelDefinitions,
    streamSimple(
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream {
      const stream = createAssistantMessageEventStream();

      (async () => {
        try {
          if (!state.currentModelRegistry) {
            throw new Error('Router provider not initialized yet. Wait for session_start and retry.');
          }
          const profile = currentConfig.profiles[model.id];
          if (!profile) {
            throw new Error(`Unknown router profile: ${model.id}`);
          }

          state.selectedProfile = model.id;
          state.routerEnabled = true;

          const pinnedTier = state.pinnedTierByProfile[model.id];
          const isBudgetExceeded =
            currentConfig.maxSessionBudget !== undefined && state.accumulatedCost >= currentConfig.maxSessionBudget;
          const lastDecision = state.lastDecision;

          let decision: RoutingDecision = decideRouting(
            context,
            model.id,
            profile,
            lastDecision,
            pinnedTier,
            state.thinkingByProfile[model.id],
            currentConfig.phaseBias,
            currentConfig.rules,
            isBudgetExceeded,
          );

          // Optional Context Trigger Upgrade
          if (currentConfig.largeContextThreshold && decision.tier !== 'high' && state.lastExtensionContext) {
            try {
              const usage = await state.lastExtensionContext.getContextUsage();
              if (usage?.tokens && usage.tokens > currentConfig.largeContextThreshold) {
                decision = buildRoutingDecision(
                  model.id,
                  profile,
                  'high',
                  'planning',
                  `Context usage (${usage.tokens}) exceeds threshold (${currentConfig.largeContextThreshold}). Forced high tier.`,
                  state.thinkingByProfile[model.id],
                  false,
                );
                decision.isContextTriggered = true;
              }
            } catch (e) {
              // ignore
            }
          }

          // ── Turn-level classifier gating ──
          const lastMessage = context.messages[context.messages.length - 1];
          const lastMsgWasTool = lastMessage?.role === 'toolResult';

          // Google thinking lock — preserve exact model on tool-result continuations
          const isGoogleContinuation =
            lastMsgWasTool &&
            lastDecision?.profile === model.id &&
            lastDecision?.targetProvider === 'google' &&
            lastDecision?.thinking !== 'off';
          if (isGoogleContinuation) {
            decision = {
              ...decision,
              tier: lastDecision.tier,
              phase: lastDecision.phase,
              targetProvider: lastDecision.targetProvider,
              targetModelId: lastDecision.targetModelId,
              targetLabel: lastDecision.targetLabel,
              thinking: lastDecision.thinking,
              reasoning: `Preserved ${lastDecision.targetLabel} for Google tool-result continuation.`,
            };
          } else {
            // Decide whether to run classifier this turn
            const classifierModel = currentConfig.classifierModel;
            const contCount = countToolResultsSinceLastUserPrompt(context);
            const shouldRunClassifier = (() => {
              if (!classifierModel) return false;
              if (pinnedTier || decision.isContextTriggered || decision.isRuleMatched) return false;
              if (!lastMsgWasTool) return true;

              const failCount = countConsecutiveRecentToolFailures(context);
              const confInitN = currentConfig.classifierInitialContinuations ?? 2;
              const confFailN = currentConfig.classifierFailureTrigger ?? 2;
              const confCadence = currentConfig.classifierCadence ?? 10;

              const triggers: string[] = [];
              if (contCount <= confInitN) triggers.push(`init(≤${confInitN})`);
              if (failCount >= confFailN) triggers.push(`fail(${failCount}≥${confFailN})`);
              const lastCad = lastDecision?.classifierContCount ?? 0; // Cadence: crossed a boundary since last classifier run
              if (confCadence > 0 && Math.floor(contCount / confCadence) > Math.floor(lastCad / confCadence)) {
                triggers.push(`cadence(%${confCadence})`);
              }
              if (state.debugEnabled && state.lastExtensionContext) {
                if (triggers.length > 0) {
                  state.lastExtensionContext.ui.notify(`RUN classifier — ${triggers.join(', ')} (cont:${contCount})`, 'info');
                } else {
                  state.lastExtensionContext.ui.notify(`SKIP classifier (cont:${contCount}, fail:${failCount})`, 'info');
                }
              }
              return triggers.length > 0;
            })();

            if (shouldRunClassifier) {
              const classifierResult = await runClassifier(
                classifierModel!,
                state.currentModelRegistry,
                context,
                lastDecision?.phase,
                currentConfig.classifierModelThinking,
              );
              if (classifierResult) {
                if (state.debugEnabled && state.lastExtensionContext) {
                  state.lastExtensionContext.ui.notify(`Classifier → ${classifierResult.tier}: ${classifierResult.reasoning}`, 'info');
                }
                decision = buildRoutingDecision(
                  model.id,
                  profile,
                  classifierResult.tier,
                  phaseForTier(classifierResult.tier),
                  `Classifier: ${classifierResult.reasoning}`,
                  state.thinkingByProfile[model.id],
                  true,
                );
                if (isBudgetExceeded && decision.tier === 'high') {
                  decision.tier = 'medium';
                  decision.phase = 'implementation';
                  decision.reasoning = `Budget exceeded. Downgraded classifier to medium. (Original: ${classifierResult.reasoning})`;
                  decision.isBudgetForced = true;
                }
              } else if (state.debugEnabled && state.lastExtensionContext) {
                state.lastExtensionContext.ui.notify('Classifier returned no result — using heuristics', 'warning');
              }
              decision.classifierContCount = contCount;
            } else {
              decision.classifierContCount = lastDecision?.classifierContCount; // Preserve the cadence counter from the previous decision
            }
          }

          const checkModelSupportsImage = (modelRef: string) => {
            try {
              const { provider, modelId } = parseCanonicalModelRef(modelRef);
              const m = state.currentModelRegistry?.find(provider, modelId);
              return m?.input?.includes('image') ?? false;
            } catch {
              return false;
            }
          };

          const detectedImageInRecentContext = imageDetectedInRecentContext(context);
          if (detectedImageInRecentContext) {
            if (state.debugEnabled && state.lastExtensionContext) {
                state.lastExtensionContext.ui.notify('Image detected in recent context, checking fallback models', 'info');
            }
            const tierModels = [decision.targetLabel, ...(profile[decision.tier].fallbacks ?? [])];
            if (!tierModels.some(checkModelSupportsImage)) {
              const tiersToTry: RouterTier[] =
                decision.tier === 'low' ? ['medium', 'high'] : decision.tier === 'medium' ? ['high'] : [];

              let foundTier: RouterTier | undefined;
              for (const t of tiersToTry) {
                const tModels = [profile[t].model, ...(profile[t].fallbacks ?? [])];
                if (tModels.some(checkModelSupportsImage)) {
                  foundTier = t;
                  break;
                }
              }

              if (foundTier) {
                decision = buildRoutingDecision(
                  model.id,
                  profile,
                  foundTier,
                  phaseForTier(foundTier),
                  `Forced ${foundTier} tier because ${decision.tier} tier lacks image support.`,
                  state.thinkingByProfile[model.id],
                  false,
                );
              } else {
                decision.reasoning += ' No image-capable models found in any tier.';
              }
            } else {
              decision.reasoning += ` Image support found in ${decision.tier} tier.`;
            }
          }

          state.lastDecision = decision;
          if (state.lastExtensionContext) {
            actions.updateStatus(state.lastExtensionContext);
          }

          let modelsToTry = [decision.targetLabel, ...(profile[decision.tier].fallbacks ?? [])];
          if (detectedImageInRecentContext) {
            modelsToTry = modelsToTry.filter(checkModelSupportsImage);
            if (modelsToTry.length === 0) {
              modelsToTry = [decision.targetLabel];
            }
          }
          let lastError: any;
          let success = false;

          for (let i = 0; i < modelsToTry.length; i++) {
            const modelRef = modelsToTry[i];
            const { provider: targetProvider, modelId: targetModelId } = parseCanonicalModelRef(modelRef);

            if (targetProvider === 'router') continue;

            const targetModel = state.currentModelRegistry.find(targetProvider, targetModelId);
            if (!targetModel) {
              lastError = new Error(`Routed model not found: ${targetProvider}/${targetModelId}`);
              continue;
            }

            const auth = await state.currentModelRegistry.getApiKeyAndHeaders(targetModel);
            if (!auth.ok || !auth.apiKey) {
              lastError = new Error(
                auth.ok
                  ? `No API key for routed model: ${targetProvider}/${targetModelId}`
                  : `Auth failed for routed model: ${targetProvider}/${targetModelId}: ${auth.error}`,
              );
              continue;
            }
            const apiKey = auth.apiKey;
            const headers = auth.headers;

            try {
              // HONESTY CHECK & AUTO-TRUNCATION
              // If the picked model has a smaller context than what we reported, truncate now.
              let effectiveContext = context;
              const targetLimit = targetModel.contextWindow || 128_000;
              if (targetLimit < model.contextWindow!) {
                effectiveContext = truncateContext(context, targetLimit);
              }

              const thinkingOverride = actions.getThinkingOverride(model.id, decision.tier);
              const delegatedReasoning =
                targetModel.reasoning && (thinkingOverride ?? decision.thinking) !== 'off'
                  ? (thinkingOverride ?? decision.thinking)
                  : undefined;

              pi.setThinkingLevel(delegatedReasoning ?? 'off');
              if (state.lastExtensionContext) {
                if (delegatedReasoning) {
                  state.lastExtensionContext.ui.setHiddenThinkingLabel?.(
                    `Thinking (${targetProvider}/${targetModelId})...`,
                  );
                } else {
                  state.lastExtensionContext.ui.setHiddenThinkingLabel?.();
                }
              }

              const delegatedStream = streamSimple(targetModel, effectiveContext, {
                ...options,
                apiKey,
                headers,
                ...(delegatedReasoning ? { reasoning: delegatedReasoning } : {}),
              });

              let contentReceived = false;
              for await (const event of delegatedStream) {
                if (event.type === 'done') {
                  const cost = event.message.usage?.cost?.total ?? 0;
                  state.accumulatedCost += cost;
                }
                if (event.type === 'error' && !contentReceived) {
                  throw new Error((event as any).error?.errorMessage || 'Model failed before sending content.');
                }
                const isContent =
                  event.type === 'text_delta' ||
                  event.type === 'thinking_delta' ||
                  event.type === 'toolcall_delta' ||
                  event.type === 'toolcall_end';
                if (isContent) contentReceived = true;
                stream.push(event);
              }
              if (modelRef !== decision.targetLabel) {
                // Update decision to reflect actual model used if it was a fallback
                decision.isFallback = true;
                decision.targetLabel = modelRef;
                decision.targetProvider = targetProvider;
                decision.targetModelId = targetModelId;

                state.lastDecision = decision;
                if (state.lastExtensionContext) {
                  actions.updateStatus(state.lastExtensionContext);
                }
              }

              success = true;
              break;
            } catch (err) {
              lastError = err;
              state.lastExtensionContext?.ui.notify( `Failed to delegate to model ${modelRef}: ${err}`,  'warning');
            }
          }

          actions.recordDebugDecision(decision);

          if (!success) {
            throw lastError || new Error('Failed to delegate to any model in the chain.');
          }

          stream.end();
        } catch (error) {
          stream.push({
            type: 'error',
            reason: 'error',
            error: createErrorMessage(model, error instanceof Error ? error.message : String(error)),
          });
          stream.end();
        } finally {
          actions.persistState();
        }
      })();

      return stream;
    },
  });

  state.lastRegisteredModels = modelsKey;
};
