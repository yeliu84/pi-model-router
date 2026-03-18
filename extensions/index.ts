import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
	type Api,
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	streamSimple,
	type Message,
	type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

type RouterTier = "high" | "medium" | "low";
type RouterPin = RouterTier | "auto";
type RouterPhase = "planning" | "implementation" | "lightweight";
type RouterPinByProfile = Partial<Record<string, RouterTier>>;

interface RoutedTierConfig {
	model: string;
	thinking?: ThinkingLevel;
}

interface RouterProfile {
	high: RoutedTierConfig;
	medium: RoutedTierConfig;
	low: RoutedTierConfig;
}

interface RouterConfig {
	defaultProfile?: string;
	debug?: boolean;
	profiles: Record<string, RouterProfile>;
}

interface RoutingDecision {
	profile: string;
	tier: RouterTier;
	phase: RouterPhase;
	targetProvider: string;
	targetModelId: string;
	targetLabel: string;
	reasoning: string;
	thinking: ThinkingLevel;
	timestamp: number;
}

interface RouterPersistedState {
	enabled: boolean;
	selectedProfile: string;
	pinTier?: RouterTier;
	pinByProfile?: RouterPinByProfile;
	debugEnabled?: boolean;
	debugHistory?: RoutingDecision[];
	lastPhase?: RouterPhase;
	lastDecision?: RoutingDecision;
	lastNonRouterModel?: string;
	timestamp: number;
}

interface ConfigLoadResult {
	config: RouterConfig;
	warnings: string[];
}

interface ParsedConfigFile {
	config: Partial<RouterConfig>;
	warnings: string[];
}

interface CustomSessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

const FALLBACK_CONFIG: RouterConfig = {
	defaultProfile: "auto",
	debug: false,
	profiles: {
		auto: {
			high: { model: "openai/gpt-5.4-pro", thinking: "high" },
			medium: { model: "google/gemini-flash-latest", thinking: "medium" },
			low: { model: "openai/gpt-5.4-nano", thinking: "low" },
		},
	},
};

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const ROUTER_PIN_VALUES: readonly RouterPin[] = ["auto", "high", "medium", "low"];
const MAX_DEBUG_HISTORY = 12;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function parseConfigFile(path: string): ParsedConfigFile {
	if (!existsSync(path)) {
		return { config: {}, warnings: [] };
	}

	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!isObjectRecord(parsed)) {
			return {
				config: {},
				warnings: [`Ignored router config at ${path}: expected a JSON object.`],
			};
		}
		return { config: parsed as Partial<RouterConfig>, warnings: [] };
	} catch (error) {
		return {
			config: {},
			warnings: [
				`Failed to parse router config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
			],
		};
	}
}

function mergeConfig(base: RouterConfig, override: Partial<RouterConfig>): RouterConfig {
	const mergedProfiles: Record<string, RouterProfile> = { ...base.profiles };
	for (const [name, profile] of Object.entries(override.profiles ?? {})) {
		const existing = mergedProfiles[name];
		mergedProfiles[name] = {
			high: { ...(existing?.high ?? FALLBACK_CONFIG.profiles.auto.high), ...(profile as Partial<RouterProfile>).high },
			medium: {
				...(existing?.medium ?? FALLBACK_CONFIG.profiles.auto.medium),
				...(profile as Partial<RouterProfile>).medium,
			},
			low: { ...(existing?.low ?? FALLBACK_CONFIG.profiles.auto.low), ...(profile as Partial<RouterProfile>).low },
		};
	}
	return {
		defaultProfile: override.defaultProfile ?? base.defaultProfile,
		debug: override.debug ?? base.debug,
		profiles: mergedProfiles,
	};
}

function parseCanonicalModelRef(value: string): { provider: string; modelId: string } {
	const slashIndex = value.indexOf("/");
	if (slashIndex === -1) {
		throw new Error(`Invalid routed model reference \"${value}\". Expected \"provider/model\".`);
	}
	const provider = value.slice(0, slashIndex).trim();
	const modelId = value.slice(slashIndex + 1).trim();
	if (!provider || !modelId) {
		throw new Error(`Invalid routed model reference \"${value}\". Expected \"provider/model\".`);
	}
	return { provider, modelId };
}

function normalizeTierConfig(
	value: unknown,
	fallback: RoutedTierConfig,
	profileName: string,
	tier: RouterTier,
	warnings: string[],
): RoutedTierConfig {
	if (!isObjectRecord(value)) {
		warnings.push(`Profile \"${profileName}\" has invalid ${tier} tier config. Falling back to ${fallback.model}.`);
		return { ...fallback };
	}

	const model = typeof value.model === "string" ? value.model.trim() : "";
	let parsedModel = fallback.model;
	if (!model) {
		warnings.push(`Profile \"${profileName}\" ${tier} tier is missing a model. Falling back to ${fallback.model}.`);
	} else {
		try {
			parseCanonicalModelRef(model);
			parsedModel = model;
		} catch (error) {
			warnings.push(error instanceof Error ? error.message : String(error));
		}
	}

	const thinking = isThinkingLevel(value.thinking) ? value.thinking : fallback.thinking;
	if (value.thinking !== undefined && !isThinkingLevel(value.thinking)) {
		warnings.push(
			`Profile \"${profileName}\" ${tier} tier has invalid thinking level. Falling back to ${fallback.thinking ?? "medium"}.`,
		);
	}

	return { model: parsedModel, thinking };
}

function normalizeConfig(raw: RouterConfig): ConfigLoadResult {
	const warnings: string[] = [];
	const normalizedProfiles: Record<string, RouterProfile> = {};
	const fallbackAuto = FALLBACK_CONFIG.profiles.auto;

	for (const [name, profile] of Object.entries(raw.profiles ?? {})) {
		normalizedProfiles[name] = {
			high: normalizeTierConfig(profile?.high, fallbackAuto.high, name, "high", warnings),
			medium: normalizeTierConfig(profile?.medium, fallbackAuto.medium, name, "medium", warnings),
			low: normalizeTierConfig(profile?.low, fallbackAuto.low, name, "low", warnings),
		};
	}

	if (Object.keys(normalizedProfiles).length === 0) {
		normalizedProfiles.auto = fallbackAuto;
		warnings.push("No valid router profiles found. Falling back to the built-in auto profile.");
	}

	let defaultProfile =
		typeof raw.defaultProfile === "string" && raw.defaultProfile.trim() ? raw.defaultProfile.trim() : undefined;
	if (!defaultProfile || !normalizedProfiles[defaultProfile]) {
		const fallbackProfile = normalizedProfiles[FALLBACK_CONFIG.defaultProfile ?? "auto"]
			? (FALLBACK_CONFIG.defaultProfile ?? "auto")
			: Object.keys(normalizedProfiles).sort()[0];
		if (defaultProfile && !normalizedProfiles[defaultProfile]) {
			warnings.push(`Default router profile \"${defaultProfile}\" was not found. Falling back to \"${fallbackProfile}\".`);
		}
		defaultProfile = fallbackProfile;
	}

	return {
		config: {
			defaultProfile,
			debug: typeof raw.debug === "boolean" ? raw.debug : false,
			profiles: normalizedProfiles,
		},
		warnings,
	};
}

function loadRouterConfig(cwd: string): ConfigLoadResult {
	const globalPath = join(getAgentDir(), "model-router.json");
	const projectPath = join(cwd, ".pi", "model-router.json");
	const globalResult = parseConfigFile(globalPath);
	const projectResult = parseConfigFile(projectPath);
	const merged = mergeConfig(mergeConfig(FALLBACK_CONFIG, globalResult.config), projectResult.config);
	const normalized = normalizeConfig(merged);
	return {
		config: normalized.config,
		warnings: [...globalResult.warnings, ...projectResult.warnings, ...normalized.warnings],
	};
}

function profileNames(config: RouterConfig): string[] {
	return Object.keys(config.profiles).sort();
}

function resolveProfileName(config: RouterConfig, requested?: string): string {
	if (requested && config.profiles[requested]) {
		return requested;
	}
	if (config.defaultProfile && config.profiles[config.defaultProfile]) {
		return config.defaultProfile;
	}
	return profileNames(config)[0] ?? "auto";
}

function formatModelRef(ref: string | undefined): string {
	return ref ?? "none";
}

function extractTextFromContent(content: string | Message["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "thinking") return part.thinking;
			if (part.type === "toolCall") return `${part.name} ${JSON.stringify(part.arguments)}`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function getLastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role === "user") {
			return extractTextFromContent(message.content).trim();
		}
	}
	return "";
}

function getRecentConversationText(context: Context, limit = 6): string {
	return context.messages
		.slice(-limit)
		.map((message) => extractTextFromContent(message.content).trim())
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
}

function countToolResults(context: Context): number {
	return context.messages.filter((message) => message.role === "toolResult").length;
}

function countWords(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

function containsAny(text: string, keywords: string[]): boolean {
	return keywords.some((keyword) => text.includes(keyword));
}

function isRouterTier(value: unknown): value is RouterTier {
	return value === "high" || value === "medium" || value === "low";
}

function isRouterPinByProfile(value: unknown): value is RouterPinByProfile {
	if (!isObjectRecord(value)) {
		return false;
	}
	return Object.values(value).every((tier) => isRouterTier(tier));
}

function isRouterPin(value: unknown): value is RouterPin {
	return typeof value === "string" && ROUTER_PIN_VALUES.includes(value as RouterPin);
}

function phaseForTier(tier: RouterTier): RouterPhase {
	if (tier === "high") return "planning";
	if (tier === "medium") return "implementation";
	return "lightweight";
}

function decideRouting(
	context: Context,
	profileName: string,
	profile: RouterProfile,
	previousDecision: RoutingDecision | undefined,
	pinnedTier?: RouterTier,
): RoutingDecision {
	const prompt = getLastUserText(context).toLowerCase();
	const recentConversation = getRecentConversationText(context);
	const toolResultCount = countToolResults(context);
	const wordCount = countWords(prompt);
	const multiLinePrompt = prompt.split("\n").length >= 4;

	const explicitHighHints = [
		"best",
		"deep",
		"deeply",
		"carefully",
		"thoroughly",
		"robust",
		"comprehensive",
		"step by step",
		"think hard",
		"highest quality",
	];
	const explicitLowHints = [
		"fast",
		"cheap",
		"quick",
		"quickly",
		"brief",
		"briefly",
		"one sentence",
		"one line",
		"tiny",
		"small",
	];
	const planningKeywords = [
		"plan",
		"planning",
		"architecture",
		"architect",
		"design",
		"tradeoff",
		"trade-off",
		"research",
		"investigate",
		"root cause",
		"analyze",
		"analysis",
		"migration",
		"strategy",
		"compare",
		"options",
		"approach",
	];
	const summaryKeywords = [
		"summarize",
		"summary",
		"changelog",
		"rewrite",
		"reformat",
		"format",
		"rename",
		"explain briefly",
		"recap",
		"tl;dr",
	];
	const implementationKeywords = [
		"implement",
		"code",
		"fix",
		"update",
		"edit",
		"write",
		"refactor",
		"add tests",
		"patch",
		"change",
		"apply",
		"continue",
		"resume",
		"make the changes",
		"go ahead",
	];
	const lookupKeywords = ["where is", "which file", "show me", "list", "what files", "find", "grep"];

	let phase: RouterPhase = previousDecision?.phase ?? "implementation";
	let tier: RouterTier = "medium";
	let reasoning = "Defaulted to medium tier for general coding work.";

	if (pinnedTier) {
		phase = phaseForTier(pinnedTier);
		tier = pinnedTier;
		reasoning = `Pinned to ${pinnedTier} tier via /router-pin.`;
	} else if (containsAny(prompt, explicitHighHints)) {
		phase = "planning";
		tier = "high";
		reasoning = "Detected an explicit request for deeper or higher-quality reasoning.";
	} else if (containsAny(prompt, explicitLowHints)) {
		phase = "lightweight";
		tier = "low";
		reasoning = "Detected an explicit request for a faster or lighter response.";
	} else if (containsAny(prompt, summaryKeywords)) {
		phase = "lightweight";
		tier = "low";
		reasoning = "Detected summary or lightweight transformation keywords.";
	} else if (
		containsAny(prompt, planningKeywords) ||
		prompt.startsWith("why ") ||
		wordCount >= 120 ||
		multiLinePrompt
	) {
		phase = "planning";
		tier = "high";
		reasoning = "Detected planning, broad analysis, or a high-complexity request.";
	} else if (containsAny(prompt, implementationKeywords)) {
		phase = "implementation";
		tier = "medium";
		reasoning = "Detected implementation-oriented work with bounded execution scope.";
	} else if (containsAny(prompt, lookupKeywords) && wordCount <= 24 && toolResultCount === 0) {
		phase = "lightweight";
		tier = "low";
		reasoning = "Detected a short read-only lookup request.";
	} else if (previousDecision?.phase === "planning" && toolResultCount === 0) {
		phase = "planning";
		tier = "high";
		reasoning = "Kept the planning-phase bias because the conversation still looks exploratory.";
	} else if (
		toolResultCount > 0 ||
		previousDecision?.phase === "implementation" ||
		recentConversation.includes("plan:")
	) {
		phase = "implementation";
		tier = "medium";
		reasoning = "Detected active implementation work from prior tools or recent plan execution context.";
	} else if (wordCount <= 12) {
		phase = "lightweight";
		tier = "low";
		reasoning = "Detected a short bounded request.";
	}

	const routed = profile[tier];
	const { provider, modelId } = parseCanonicalModelRef(routed.model);
	return {
		profile: profileName,
		tier,
		phase,
		targetProvider: provider,
		targetModelId: modelId,
		targetLabel: routed.model,
		reasoning,
		thinking: routed.thinking ?? "medium",
		timestamp: Date.now(),
	};
}

function formatDecision(decision: RoutingDecision): string {
	return `${decision.profile}: ${decision.tier} -> ${decision.targetProvider}/${decision.targetModelId} (${decision.reasoning})`;
}

function createErrorMessage(model: Model<Api>, message: string): AssistantMessage {
	return {
		role: "assistant",
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
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

function isRoutingDecision(value: unknown): value is RoutingDecision {
	if (!isObjectRecord(value)) {
		return false;
	}
	return (
		typeof value.profile === "string" &&
		(value.tier === "high" || value.tier === "medium" || value.tier === "low") &&
		(value.phase === "planning" || value.phase === "implementation" || value.phase === "lightweight") &&
		typeof value.targetProvider === "string" &&
		typeof value.targetModelId === "string" &&
		typeof value.targetLabel === "string" &&
		typeof value.reasoning === "string" &&
		isThinkingLevel(value.thinking) &&
		typeof value.timestamp === "number"
	);
}

function isRouterPersistedState(value: unknown): value is RouterPersistedState {
	if (!isObjectRecord(value)) {
		return false;
	}
	return (
		typeof value.enabled === "boolean" &&
		typeof value.selectedProfile === "string" &&
		(value.pinTier === undefined || isRouterTier(value.pinTier)) &&
		(value.pinByProfile === undefined || isRouterPinByProfile(value.pinByProfile)) &&
		(value.debugEnabled === undefined || typeof value.debugEnabled === "boolean") &&
		(value.debugHistory === undefined ||
			(Array.isArray(value.debugHistory) && value.debugHistory.every((decision) => isRoutingDecision(decision)))) &&
		(value.lastPhase === undefined ||
			value.lastPhase === "planning" ||
			value.lastPhase === "implementation" ||
			value.lastPhase === "lightweight") &&
		(value.lastDecision === undefined || isRoutingDecision(value.lastDecision)) &&
		(value.lastNonRouterModel === undefined || typeof value.lastNonRouterModel === "string") &&
		typeof value.timestamp === "number"
	);
}

export default function routerExtension(pi: ExtensionAPI) {
	let currentConfig: RouterConfig = FALLBACK_CONFIG;
	let currentModelRegistry: ExtensionContext["modelRegistry"] | undefined;
	let currentCwd = process.cwd();
	let lastDecision: RoutingDecision | undefined;
	let debugEnabled = false;
	let routerEnabled = false;
	let selectedProfile = resolveProfileName(FALLBACK_CONFIG, FALLBACK_CONFIG.defaultProfile);
	let pinnedTierByProfile: RouterPinByProfile = {};
	let debugHistory: RoutingDecision[] = [];
	let lastNonRouterModel: string | undefined;
	let lastConfigWarnings: string[] = [];
	let lastPersistedSnapshot: string | undefined;

	const getProfileCompletions = (prefix: string) => {
		const items = profileNames(currentConfig)
			.filter((name) => name.startsWith(prefix))
			.map((name) => ({ value: name, label: `router/${name}` }));
		return items.length > 0 ? items : null;
	};

	const getRouterPinArgumentCompletions = (prefix: string) => {
		const trimmedLeft = prefix.trimStart();
		const hasTrailingSpace = /\s$/.test(prefix);
		const parts = trimmedLeft.length > 0 ? trimmedLeft.split(/\s+/) : [];

		if (parts.length === 0) {
			return [
				...ROUTER_PIN_VALUES.map((value) => ({ value, label: value })),
				...profileNames(currentConfig).map((name) => ({ value: name, label: `router/${name}` })),
			];
		}

		if (parts.length === 1 && !hasTrailingSpace) {
			const token = parts[0];
			const pinItems = ROUTER_PIN_VALUES.filter((value) => value.startsWith(token)).map((value) => ({
				value,
				label: value,
			}));
			const profileItems = profileNames(currentConfig)
				.filter((name) => name.startsWith(token))
				.map((name) => ({ value: name, label: `router/${name}` }));
			const items = [...pinItems, ...profileItems];
			return items.length > 0 ? items : null;
		}

		const profileToken = parts[0];
		if (!currentConfig.profiles[profileToken]) {
			return null;
		}
		const pinPrefix = hasTrailingSpace ? "" : (parts[1] ?? "");
		const items = ROUTER_PIN_VALUES.filter((value) => value.startsWith(pinPrefix)).map((value) => ({
			value: `${profileToken} ${value}`,
			label: `${profileToken} ${value}`,
		}));
		return items.length > 0 ? items : null;
	};

	const notifyConfigWarnings = (ctx: ExtensionContext) => {
		if (lastConfigWarnings.length === 0) {
			return;
		}
		ctx.ui.notify(lastConfigWarnings.join("\n"), "warning");
	};

	const getPinnedTierForProfile = (profileName: string): RouterTier | undefined => pinnedTierByProfile[profileName];

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

	const buildPersistedState = (): RouterPersistedState => ({
		enabled: routerEnabled,
		selectedProfile,
		pinTier: getPinnedTierForProfile(selectedProfile),
		pinByProfile: { ...pinnedTierByProfile },
		debugEnabled,
		debugHistory,
		lastPhase: lastDecision?.phase,
		lastDecision,
		lastNonRouterModel,
		timestamp: Date.now(),
	});

	const persistState = () => {
		const state = buildPersistedState();
		const snapshot = JSON.stringify({
			...state,
			timestamp: 0,
			lastDecision: state.lastDecision ? { ...state.lastDecision, timestamp: 0 } : undefined,
			debugHistory: state.debugHistory?.map((decision) => ({ ...decision, timestamp: 0 })),
		});
		if (snapshot === lastPersistedSnapshot) {
			return;
		}
		pi.appendEntry("router-state", state);
		lastPersistedSnapshot = snapshot;
	};

	const formatPinSummary = () => {
		const entries = Object.entries(pinnedTierByProfile)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([profile, tier]) => `${profile}:${tier}`);
		return entries.length > 0 ? entries.join(", ") : "none";
	};

	const updateStatus = (ctx: ExtensionContext) => {
		const activeModel = ctx.model;
		const activeRouterProfile = activeModel?.provider === "router" ? activeModel.id : undefined;
		const statusProfile = activeRouterProfile ?? selectedProfile;
		const activePin = getPinnedTierForProfile(statusProfile);
		const pinLabel = activePin ? ` [pin:${activePin}]` : "";

		let statusText: string;
		if (activeRouterProfile) {
			if (lastDecision && lastDecision.profile === activeRouterProfile) {
				statusText = `router:${activeRouterProfile}${pinLabel} -> ${lastDecision.tier} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId}`;
			} else {
				statusText = `router:${activeRouterProfile}${pinLabel} -> waiting`;
			}
		} else {
			statusText = routerEnabled
				? `router:${selectedProfile}${pinLabel} -> idle`
				: `router:off (${selectedProfile}${pinLabel}) -> ${formatModelRef(lastNonRouterModel)}`;
		}
		ctx.ui.setStatus("router", statusText);

		const widgetLines = [
			`Router: ${routerEnabled ? "enabled" : "disabled"}`,
			`Profile: ${statusProfile}${activeRouterProfile ? " (active)" : ""}`,
			`Pin: ${activePin ?? "auto"}`,
		];
		if (lastDecision && lastDecision.profile === statusProfile) {
			widgetLines.push(
				`Route: ${lastDecision.tier} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId}`,
				`Phase: ${lastDecision.phase}`,
			);
		} else if (!routerEnabled && lastNonRouterModel) {
			widgetLines.push(`Fallback: ${lastNonRouterModel}`);
		}
		if (Object.keys(pinnedTierByProfile).length > 1) {
			widgetLines.push(`Pins: ${formatPinSummary()}`);
		}
		ctx.ui.setWidget("router", widgetLines);
	};

	const registerRouterProvider = () => {
		const models = profileNames(currentConfig).map((name) => ({
			id: name,
			name: `Router ${name}`,
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 2_000_000,
			maxTokens: 128_000,
		}));

		pi.registerProvider("router", {
			baseUrl: "router://local",
			apiKey: "pi-model-router",
			api: "router-local-api",
			models,
			streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
				const stream = createAssistantMessageEventStream();

				(async () => {
					try {
						if (!currentModelRegistry) {
							throw new Error("Router provider not initialized yet. Wait for session_start and retry.");
						}
						const profile = currentConfig.profiles[model.id];
						if (!profile) {
							throw new Error(`Unknown router profile: ${model.id}`);
						}

						selectedProfile = model.id;
						routerEnabled = true;
						const decision = decideRouting(
							context,
							model.id,
							profile,
							lastDecision,
							getPinnedTierForProfile(model.id),
						);
						lastDecision = decision;
						recordDebugDecision(decision);

						if (decision.targetProvider === "router") {
							throw new Error("Router profiles may not point at router/* models.");
						}

						const targetModel = currentModelRegistry.find(decision.targetProvider, decision.targetModelId);
						if (!targetModel) {
							throw new Error(`Routed model not found: ${decision.targetProvider}/${decision.targetModelId}`);
						}

						const apiKey = await currentModelRegistry.getApiKey(targetModel);
						if (!apiKey) {
							throw new Error(`No API key for routed model: ${decision.targetProvider}/${decision.targetModelId}`);
						}

						const delegatedStream = streamSimple(targetModel, context, {
							...options,
							apiKey,
							reasoning: targetModel.reasoning ? decision.thinking : "off",
						});

						for await (const event of delegatedStream) {
							stream.push(event);
						}
						persistState();
						stream.end();
					} catch (error) {
						stream.push({
							type: "error",
							reason: "error",
							error: createErrorMessage(model, error instanceof Error ? error.message : String(error)),
						});
						stream.end();
					}
				})();

				return stream;
			},
		});
	};

	const reloadConfig = (ctx?: ExtensionContext, options?: { preserveDebug?: boolean }) => {
		const loaded = loadRouterConfig(currentCwd);
		currentConfig = loaded.config;
		lastConfigWarnings = loaded.warnings;
		if (!options?.preserveDebug) {
			debugEnabled = currentConfig.debug ?? false;
		}
		selectedProfile = resolveProfileName(currentConfig, selectedProfile);
		registerRouterProvider();
		if (ctx) {
			updateStatus(ctx);
		}
	};

	const ensureValidActiveRouterProfile = async (ctx: ExtensionContext) => {
		if (ctx.model?.provider !== "router") {
			return;
		}
		if (currentConfig.profiles[ctx.model.id]) {
			selectedProfile = ctx.model.id;
			routerEnabled = true;
			return;
		}

		const fallbackProfile = resolveProfileName(currentConfig, selectedProfile);
		const fallbackModel = ctx.modelRegistry.find("router", fallbackProfile);
		selectedProfile = fallbackProfile;
		if (!fallbackModel) {
			ctx.ui.notify(`Router profile \"${ctx.model.id}\" is no longer configured.`, "warning");
			return;
		}

		await pi.setModel(fallbackModel);
		ctx.ui.notify(
			`Router profile \"${ctx.model.id}\" is no longer configured. Switched to router/${fallbackProfile}.`,
			"warning",
		);
	};

	const switchToRouterProfile = async (profileName: string, ctx: ExtensionContext, strict = true) => {
		if (strict && !currentConfig.profiles[profileName]) {
			ctx.ui.notify(`Unknown router profile: ${profileName}`, "error");
			return false;
		}
		const resolvedProfile = resolveProfileName(currentConfig, profileName);
		const routerModel = ctx.modelRegistry.find("router", resolvedProfile);
		if (!routerModel) {
			ctx.ui.notify(`Unknown router profile: ${profileName}`, "error");
			return false;
		}
		if (ctx.model && ctx.model.provider !== "router") {
			lastNonRouterModel = `${ctx.model.provider}/${ctx.model.id}`;
		}
		const success = await pi.setModel(routerModel);
		if (!success) {
			ctx.ui.notify(`Failed to switch to router/${resolvedProfile}`, "error");
			return false;
		}
		selectedProfile = resolvedProfile;
		routerEnabled = true;
		persistState();
		updateStatus(ctx);
		return true;
	};

	const restoreStateFromSession = async (ctx: ExtensionContext) => {
		currentModelRegistry = ctx.modelRegistry;
		currentCwd = ctx.cwd;
		reloadConfig(ctx);

		routerEnabled = ctx.model?.provider === "router";
		selectedProfile = resolveProfileName(currentConfig, ctx.model?.provider === "router" ? ctx.model.id : selectedProfile);
		pinnedTierByProfile = {};
		debugHistory = [];
		lastNonRouterModel = ctx.model && ctx.model.provider !== "router" ? `${ctx.model.provider}/${ctx.model.id}` : lastNonRouterModel;
		lastDecision = undefined;

		const entries = ctx.sessionManager.getBranch() as CustomSessionEntry[];
		const savedState = entries
			.filter((entry) => entry.type === "custom" && entry.customType === "router-state")
			.map((entry) => entry.data)
			.findLast((data) => isRouterPersistedState(data) || isRoutingDecision(data));

		if (isRouterPersistedState(savedState)) {
			selectedProfile = resolveProfileName(
				currentConfig,
				routerEnabled && ctx.model?.provider === "router" ? ctx.model.id : savedState.selectedProfile,
			);
			pinnedTierByProfile = savedState.pinByProfile ? { ...savedState.pinByProfile } : {};
			if (savedState.pinTier) {
				setPinnedTierForProfile(selectedProfile, savedState.pinTier);
			}
			debugEnabled = savedState.debugEnabled ?? debugEnabled;
			debugHistory = savedState.debugHistory ? [...savedState.debugHistory].slice(-MAX_DEBUG_HISTORY) : [];
			lastDecision = savedState.lastDecision;
			lastNonRouterModel = savedState.lastNonRouterModel ?? lastNonRouterModel;
		} else if (isRoutingDecision(savedState)) {
			lastDecision = savedState;
			selectedProfile = resolveProfileName(currentConfig, savedState.profile);
		}

		await ensureValidActiveRouterProfile(ctx);
		persistState();
		updateStatus(ctx);
	};

	currentConfig = loadRouterConfig(currentCwd).config;
	selectedProfile = resolveProfileName(currentConfig, currentConfig.defaultProfile);
	reloadConfig();

	pi.registerCommand("router", {
		description: "Show router state, config, and the last routing decision",
		handler: async (_args, ctx) => {
			const names = profileNames(currentConfig).join(", ");
			const lines = [
				`Enabled: ${routerEnabled ? "yes" : "no"}`,
				`Selected profile: ${selectedProfile}`,
				`Selected profile pin: ${getPinnedTierForProfile(selectedProfile) ?? "auto"}`,
				`Pins by profile: ${formatPinSummary()}`,
				`Default profile: ${resolveProfileName(currentConfig, currentConfig.defaultProfile)}`,
				`Available profiles: ${names}`,
				`Last non-router model: ${formatModelRef(lastNonRouterModel)}`,
				`Debug: ${debugEnabled ? "on" : "off"}`,
				`Debug history: ${debugHistory.length} decisions`,
			];
			if (lastDecision) {
				lines.push(
					`Last routed tier: ${lastDecision.tier}`,
					`Last phase: ${lastDecision.phase}`,
					`Last model: ${lastDecision.targetProvider}/${lastDecision.targetModelId}`,
					`Reason: ${lastDecision.reasoning}`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
			notifyConfigWarnings(ctx);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("router-reload", {
		description: "Reload router config and re-register router profiles",
		handler: async (_args, ctx) => {
			reloadConfig(ctx, { preserveDebug: true });
			await ensureValidActiveRouterProfile(ctx);
			ctx.ui.notify(`Router config reloaded. Profiles: ${profileNames(currentConfig).join(", ")}`, "info");
			notifyConfigWarnings(ctx);
		},
	});

	pi.registerCommand("router-debug", {
		description: "Show router debug state/history or set debug on|off|toggle|clear",
		handler: async (args, ctx) => {
			const command = args?.trim().toLowerCase();
			if (command === "on") {
				debugEnabled = true;
				persistState();
				updateStatus(ctx);
				ctx.ui.notify("Router debug enabled", "info");
				return;
			}
			if (command === "off") {
				debugEnabled = false;
				persistState();
				updateStatus(ctx);
				ctx.ui.notify("Router debug disabled", "info");
				return;
			}
			if (command === "toggle") {
				debugEnabled = !debugEnabled;
				persistState();
				updateStatus(ctx);
				ctx.ui.notify(`Router debug ${debugEnabled ? "enabled" : "disabled"}`, "info");
				return;
			}
			if (command === "clear") {
				debugHistory = [];
				persistState();
				ctx.ui.notify("Router debug history cleared", "info");
				return;
			}

			const historyLines =
				debugHistory.length > 0
					? debugHistory
							.slice()
							.reverse()
							.map((decision, index) => `${index + 1}. ${formatDecision(decision)}`)
							.join("\n")
					: "none";
			ctx.ui.notify(
				[
					`Debug: ${debugEnabled ? "on" : "off"}`,
					`Selected profile: ${selectedProfile}`,
					`Pins by profile: ${formatPinSummary()}`,
					`History size: ${debugHistory.length}`,
					`Recent decisions:\n${historyLines}`,
					"Commands: /router-debug on | off | toggle | clear",
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("router-profile", {
		description: "Switch to a logical router profile model",
		getArgumentCompletions: getProfileCompletions,
		handler: async (args, ctx) => {
			const profileName = args?.trim();
			if (!profileName) {
				ctx.ui.notify(`Available profiles: ${profileNames(currentConfig).join(", ")}`, "info");
				return;
			}
			const success = await switchToRouterProfile(profileName, ctx);
			if (success) {
				ctx.ui.notify(`Switched to router/${selectedProfile}`, "info");
			}
		},
	});

	pi.registerCommand("router-on", {
		description: "Enable the router by switching to the selected or default router profile",
		getArgumentCompletions: getProfileCompletions,
		handler: async (args, ctx) => {
			const requestedProfile = args?.trim() || selectedProfile || currentConfig.defaultProfile;
			const success = await switchToRouterProfile(resolveProfileName(currentConfig, requestedProfile), ctx, false);
			if (success) {
				ctx.ui.notify(`Router enabled with router/${selectedProfile}`, "info");
			}
		},
	});

	pi.registerCommand("router-pin", {
		description: "Pin routing for the current profile or a named profile",
		getArgumentCompletions: getRouterPinArgumentCompletions,
		handler: async (args, ctx) => {
			const currentProfile = ctx.model?.provider === "router" ? ctx.model.id : selectedProfile;
			const trimmed = args?.trim();
			if (!trimmed) {
				ctx.ui.notify(
					[
						`Profile: ${currentProfile}`,
						`Pinned tier: ${getPinnedTierForProfile(currentProfile) ?? "auto"}`,
						`Pins by profile: ${formatPinSummary()}`,
						`Usage: /router-pin <high|medium|low|auto>`,
						`   or: /router-pin <profile> <high|medium|low|auto>`,
					].join("\n"),
					"info",
				);
				updateStatus(ctx);
				return;
			}

			const parts = trimmed.split(/\s+/).filter(Boolean);
			let profileName = currentProfile;
			let pinValue = parts[0] ?? "";
			if (parts.length >= 2) {
				profileName = parts[0];
				pinValue = parts[1] ?? "";
			}
			if (!currentConfig.profiles[profileName]) {
				ctx.ui.notify(`Unknown router profile: ${profileName}`, "error");
				return;
			}
			if (!isRouterPin(pinValue)) {
				ctx.ui.notify(`Invalid router pin: ${pinValue}. Use one of: ${ROUTER_PIN_VALUES.join(", ")}`, "error");
				return;
			}

			const nextTier = pinValue === "auto" ? undefined : pinValue;
			setPinnedTierForProfile(profileName, nextTier);
			persistState();
			updateStatus(ctx);
			ctx.ui.notify(
				nextTier
					? `Router profile ${profileName} pinned to ${nextTier}`
					: `Router profile ${profileName} pin cleared; heuristic routing restored`,
				"info",
			);
		},
	});

	pi.registerCommand("router-off", {
		description: "Disable the router by switching back to the last non-router model",
		handler: async (_args, ctx) => {
			if (!lastNonRouterModel) {
				ctx.ui.notify("No previous non-router model recorded. Use /model to pick a concrete model.", "warning");
				return;
			}
			const { provider, modelId } = parseCanonicalModelRef(lastNonRouterModel);
			const targetModel = ctx.modelRegistry.find(provider, modelId);
			if (!targetModel) {
				ctx.ui.notify(`Recorded non-router model is unavailable: ${lastNonRouterModel}`, "error");
				return;
			}
			const success = await pi.setModel(targetModel);
			if (!success) {
				ctx.ui.notify(`Failed to switch to ${lastNonRouterModel}`, "error");
				return;
			}
			routerEnabled = false;
			persistState();
			updateStatus(ctx);
			ctx.ui.notify(`Router disabled. Restored ${lastNonRouterModel}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await restoreStateFromSession(ctx);
		notifyConfigWarnings(ctx);
		if (debugEnabled) {
			ctx.ui.notify(`Router initialized with profiles: ${profileNames(currentConfig).join(", ")}`, "info");
		}
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.model.provider === "router") {
			routerEnabled = true;
			selectedProfile = resolveProfileName(currentConfig, event.model.id);
		} else {
			routerEnabled = false;
			lastNonRouterModel = `${event.model.provider}/${event.model.id}`;
		}
		persistState();
		updateStatus(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await restoreStateFromSession(ctx);
		notifyConfigWarnings(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		await restoreStateFromSession(ctx);
		notifyConfigWarnings(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		persistState();
		updateStatus(ctx);
		if (debugEnabled && lastDecision) {
			ctx.ui.notify(formatDecision(lastDecision), "info");
		}
	});
}
