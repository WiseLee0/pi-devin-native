import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// The public entrypoint exports the union, but not its chat constituent.
export type ProviderChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;
import { DEVIN_DEFAULT_BASE_URL, devinDiscoveryMetadata } from "./devin.js";
import { decodeDevinUnaryMessage } from "./devin-proto.js";
import {
	type ClientModelConfig,
	DisplayOption,
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
	MetadataSchema,
	ModelDimensionKind,
} from "./vendor/devin-proto.js";
import { create, toBinary } from "./vendor/protobuf.js";

const DISCOVERY_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
// The descriptor predates slots 6–8, but their int32 values round-trip intact.
const SUPPORTED_DISPLAYS = [3, 4, 6, 7, 8] as DisplayOption[];
const INTERNAL_DISPLAYS = new Set<number>([4, 6]);
const IMAGE_BLIND_UIDS = new Set(["swe-1-6", "swe-1-6-fast"]);

export interface DevinModelRoute {
	modelRouter?: boolean;
	supportsParallelToolCalls?: boolean;
	requestModelId?: string;
}

const modelRoutes = new Map<string, DevinModelRoute>();

/**
 * Persisted samplingParams.devin takes precedence over the in-process catalog.
 * Stream callers may pass their model as the second argument after a restart.
 * These fields are routing metadata, NOT sampling options to send to Devin.
 */
export function getModelRoute(
	id: string,
	model?: { samplingParams?: Record<string, unknown> },
): DevinModelRoute {
	const persisted = model?.samplingParams?.devin;
	if (persisted !== null && typeof persisted === "object" && !Array.isArray(persisted)) {
		const fields = persisted as Record<string, unknown>;
		const route: DevinModelRoute = {};
		if (typeof fields.modelRouter === "boolean") route.modelRouter = fields.modelRouter;
		if (typeof fields.supportsParallelToolCalls === "boolean") {
			route.supportsParallelToolCalls = fields.supportsParallelToolCalls;
		}
		if (typeof fields.requestModelId === "string" && fields.requestModelId.trim()) {
			route.requestModelId = fields.requestModelId;
		}
		return route;
	}
	return { ...modelRoutes.get(id) };
}

type ThinkingLevelMap = NonNullable<ProviderChatModelConfig["thinkingLevelMap"]>;
type NativeThinkingLevel = Exclude<keyof ThinkingLevelMap, "off">;

/** Match whole effort tokens, not substrings such as "highlander" or "maximum". */
function nativeThinkingLevel(value: string): NativeThinkingLevel | undefined {
	const tokens = value.toLowerCase().split(/[^a-z0-9]+/);
	const levels = tokens.filter((token): token is NativeThinkingLevel =>
		["minimal", "low", "medium", "high", "xhigh", "max"].includes(token));
	const unique = [...new Set(levels)];
	return unique.length === 1 ? unique[0] : undefined;
}

/** The sole Pi level describes the fixed native UID; it is not a wire option. */
function thinkingLevelMap(reasoning: boolean, uid = "", label = ""): ThinkingLevelMap {
	const map: ThinkingLevelMap = {
		off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
	};
	if (reasoning) {
		// UID wins over display labels. Unspecified effort keeps the legacy high
		// placeholder because Pi has no "default/unknown" thinking level.
		const level = nativeThinkingLevel(uid) ?? nativeThinkingLevel(label) ?? "high";
		map[level] = "default";
	}
	return map;
}

/** Synchronous boot seed only. Discovery errors never silently return this. */
export const FALLBACK_MODELS: ProviderChatModelConfig[] = [
	{
		id: "swe-1-6",
		name: "SWE-1.6",
		api: "devin-native-connect",
		baseUrl: DEVIN_DEFAULT_BASE_URL,
		reasoning: false,
		thinkingLevelMap: thinkingLevelMap(false),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		samplingParams: { devin: {} },
	},
];

function supportsThinking(config: ClientModelConfig): boolean {
	const features = config.modelInfo?.modelFeatures;
	if (features !== undefined) return features.supportsThinking;
	if (/\bno thinking\b/i.test(config.label)) return false;
	return /\b(think|thinking|minimal|high|medium|low|xhigh|max|reasoning)\b/i.test(config.label);
}

function denominatorTokens(denominator: string): number {
	const match = /(\d+(?:\.\d+)?)\s*([kmb])?/i.exec(denominator);
	if (!match) return 1_000_000;
	const scale = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[2]?.toLowerCase() ?? ""] ?? 1;
	const tokens = Number(match[1]) * scale;
	return tokens > 0 && Number.isFinite(tokens) ? tokens : 1_000_000;
}

function modelCost(config: ClientModelConfig): ProviderChatModelConfig["cost"] {
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const dimension of config.modelDimensions) {
		const label = dimension.label.trim().toLowerCase();
		// Composite rate cards include component cards after this marker.
		if (label === "sidekick") break;
		if (dimension.kind !== ModelDimensionKind.COST && dimension.kind !== ModelDimensionKind.COST_FUZZY) continue;
		const value = Math.round((dimension.value * 1_000_000 / denominatorTokens(dimension.denominator)) * 1e6) / 1e6;
		if (!Number.isFinite(value) || value < 0) continue;
		if (label === "input") cost.input = value;
		else if (label === "output") cost.output = value;
		else if (label === "cached input") cost.cacheRead = value;
	}
	return cost;
}

/** Native UIDs stay separate, including every reasoning-effort variant. */
export function normalizeDevinModels(
	configs: readonly ClientModelConfig[],
	baseUrl = DEVIN_DEFAULT_BASE_URL,
): ProviderChatModelConfig[] {
	const models: ProviderChatModelConfig[] = [];
	const routes = new Map<string, DevinModelRoute>();
	for (const config of configs) {
		const uid = config.modelUid.trim();
		const info = config.modelInfo;
		const display = info?.displayOption ?? DisplayOption.UNSPECIFIED;
		const features = info?.modelFeatures;
		if (config.disabled || INTERNAL_DISPLAYS.has(display) || !uid || routes.has(uid)) continue;
		if (features?.supportsToolCalls === false) continue;
		// Native orchestrates these pairings locally. Do not send composite UIDs
		// to chat, nor advertise sidekick orchestration this provider cannot run.
		if (uid.startsWith("fusion-") && uid.indexOf("-sidekick-") > "fusion-".length) continue;

		const route: DevinModelRoute = {};
		const isRouter = display === DisplayOption.MODEL_ROUTER || info?.isModelRouter === true;
		// Harness-backed composites are chat UIDs, not AssignModel routers.
		if (isRouter && (info?.harnessUids.length ?? 0) === 0) route.modelRouter = true;
		if (features?.supportsParallelToolCalls === true) route.supportsParallelToolCalls = true;
		const reasoning = supportsThinking(config);
		const images = (features?.supportsImages ?? config.supportsImages) && !IMAGE_BLIND_UIDS.has(uid);
		models.push({
			id: uid,
			name: config.label.trim() || uid,
			api: "devin-native-connect",
			baseUrl: baseUrl.replace(/\/+$/, ""),
			reasoning,
			thinkingLevelMap: thinkingLevelMap(reasoning, uid, config.label),
			input: images ? ["text", "image"] : ["text"],
			cost: modelCost(config),
			contextWindow: config.maxTokens > 0 ? config.maxTokens : (info?.maxTokens ?? 0) > 0 ? info!.maxTokens : DEFAULT_CONTEXT_WINDOW,
			maxTokens: (info?.maxOutputTokens ?? 0) > 0 ? info!.maxOutputTokens : DEFAULT_MAX_TOKENS,
			samplingParams: { devin: { ...route } },
		});
		routes.set(uid, route);
	}
	modelRoutes.clear();
	for (const [uid, route] of routes) modelRoutes.set(uid, route);
	return models.sort((a, b) => a.id.localeCompare(b.id));
}

export async function fetchDevinModels(
	apiKey: string,
	options: { fetch?: typeof fetch; signal?: AbortSignal; baseUrl?: string } = {},
): Promise<ProviderChatModelConfig[]> {
	const baseUrl = options.baseUrl ?? DEVIN_DEFAULT_BASE_URL;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5_000);
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
	try {
		signal.throwIfAborted();
		const metadata = create(MetadataSchema, {
			...devinDiscoveryMetadata(apiKey),
			supportedModelDisplays: [...SUPPORTED_DISPLAYS],
		});
		const request = create(GetCliModelConfigsRequestSchema, { metadata });
		const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl.replace(/\/+$/, "")}${DISCOVERY_PATH}`, {
			method: "POST",
			headers: {
				"content-type": "application/proto",
				"connect-protocol-version": "1",
				accept: "*/*",
			},
			body: toBinary(GetCliModelConfigsRequestSchema, request),
			redirect: "error",
			signal,
		});
		if (!response.ok) throw new Error(`Devin model discovery failed: HTTP ${response.status}`);
		const decoded = decodeDevinUnaryMessage(
			GetCliModelConfigsResponseSchema,
			new Uint8Array(await response.arrayBuffer()),
		);
		if (decoded === null) throw new Error("Devin model discovery returned invalid protobuf");
		const models = normalizeDevinModels(decoded.clientModelConfigs, baseUrl);
		if (models.length === 0) throw new Error("Devin model discovery returned no usable models");
		return models;
	} finally {
		clearTimeout(timer);
	}
}
