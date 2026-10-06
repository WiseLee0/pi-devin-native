import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { FALLBACK_MODELS, fetchDevinModels, getModelRoute, normalizeDevinModels } from "../src/discovery.js";
import { DEVIN_DEFAULT_BASE_URL } from "../src/devin.js";
import {
	type ClientModelConfig,
	ClientModelConfigSchema,
	DisplayOption,
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
	ModelDimensionKind,
	ModelDimensionSchema,
	ModelFamilyMetadataSchema,
	ModelFeaturesSchema,
	ModelInfoSchema,
} from "../src/vendor/devin-proto.js";
import { create, fromBinary, toBinary } from "../src/vendor/protobuf.js";

function config(uid: string, fields: Partial<ClientModelConfig> = {}): ClientModelConfig {
	return create(ClientModelConfigSchema, { modelUid: uid, label: uid, ...fields });
}

function featureInfo(fields: Parameters<typeof ModelFeaturesSchema.create>[0] = {}) {
	return create(ModelInfoSchema, {
		modelFeatures: create(ModelFeaturesSchema, { supportsToolCalls: true, ...fields }),
	});
}

function catalog(configs: ClientModelConfig[], gzip = false): Response {
	const bytes = toBinary(GetCliModelConfigsResponseSchema, create(GetCliModelConfigsResponseSchema, {
		clientModelConfigs: configs,
	}));
	return new Response(gzip ? gzipSync(bytes) : bytes);
}

function mockFetch(fn: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
	return (async (input, init) => fn(input, init)) as typeof fetch;
}

test("fallback is a synchronous, text-only SWE-1.6 seed with no adjustable thinking", () => {
	assert.equal(FALLBACK_MODELS.length, 1);
	const seed = FALLBACK_MODELS[0];
	assert.equal(seed.id, "swe-1-6");
	assert.equal(seed.api, "devin-native-connect");
	assert.equal(seed.baseUrl, DEVIN_DEFAULT_BASE_URL);
	assert.deepEqual(seed.input, ["text"]);
	assert.equal(seed.reasoning, false);
	assert.deepEqual(Object.values(seed.thinkingLevelMap!), Array(7).fill(null));
});

test("discovery sends native dev-channel protobuf metadata and a single Connect request", async () => {
	let calls = 0;
	const models = await fetchDevinModels("test-key", {
		baseUrl: "https://example.test///",
		fetch: mockFetch((url, init) => {
			calls++;
			assert.equal(url, "https://example.test/exa.api_server_pb.ApiServerService/GetCliModelConfigs");
			assert.equal(init?.method, "POST");
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("content-type"), "application/proto");
			assert.equal(headers.get("connect-protocol-version"), "1");
			assert.ok(init?.signal instanceof AbortSignal);
			const request = fromBinary(GetCliModelConfigsRequestSchema, init?.body as Uint8Array);
			assert.equal(request.metadata?.apiKey, "devin-session-token$test-key");
			assert.equal(request.metadata?.ideName, "chisel");
			assert.equal(request.metadata?.ideVersion, "0.0.0-dev");
			assert.equal(request.metadata?.extensionName, "chisel");
			assert.equal(request.metadata?.extensionVersion, "0.0.0-dev");
			assert.deepEqual(request.metadata?.supportedModelDisplays, [3, 4, 6, 7, 8]);
			return catalog([config("swe-1-6")]);
		}),
	});
	assert.equal(calls, 1, "even a seed-only response must not try legacy discovery");
	assert.equal(models[0].id, "swe-1-6");
	assert.equal(models[0].baseUrl, "https://example.test");
});

test("gzipped unary protobuf and already-prefixed session tokens are supported", async () => {
	const models = await fetchDevinModels("devin-session-token$test-key", {
		fetch: mockFetch((_url, init) => {
			const request = fromBinary(GetCliModelConfigsRequestSchema, init?.body as Uint8Array);
			assert.equal(request.metadata?.apiKey, "devin-session-token$test-key");
			return catalog([config("native-uid")], true);
		}),
	});
	assert.equal(models[0].id, "native-uid");
});

test("HTTP, network, malformed protobuf, empty and unusable catalogs reject instead of fallback", async () => {
	await assert.rejects(fetchDevinModels("test-key", {
		fetch: mockFetch(() => new Response("denied", { status: 403 })),
	}), /HTTP 403/);
	const failure = new Error("offline");
	await assert.rejects(fetchDevinModels("test-key", {
		fetch: mockFetch(() => { throw failure; }),
	}), error => error === failure);
	await assert.rejects(fetchDevinModels("test-key", {
		fetch: mockFetch(() => new Response(new Uint8Array([255]))),
	}), /invalid protobuf/);
	for (const configs of [[], [config("disabled", { disabled: true })], [config("no-tools", {
		modelInfo: featureInfo({ supportsToolCalls: false }),
	})]]) {
		await assert.rejects(fetchDevinModels("test-key", { fetch: mockFetch(() => catalog(configs)) }), /no usable models/);
	}
});

test("discovery respects pre-aborted signals without fetching", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(fetchDevinModels("test-key", {
		signal: controller.signal,
		fetch: mockFetch(() => { assert.fail("must not fetch"); }),
	}), { name: "AbortError" });
});

test("caller cancellation reaches an in-flight discovery request", async () => {
	const controller = new AbortController();
	const result = fetchDevinModels("test-key", {
		signal: controller.signal,
		fetch: mockFetch((_url, init) => new Promise((_resolve, reject) => {
			init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
		})),
	});
	controller.abort();
	await assert.rejects(result, { name: "AbortError" });
});

test("normalization filters disabled/internal/no-tool configs but retains slots 7 and 8", () => {
	const models = normalizeDevinModels([
		config("disabled", { disabled: true }),
		config("quick", { modelInfo: create(ModelInfoSchema, { displayOption: 4 }) }),
		config("internal", { modelInfo: create(ModelInfoSchema, { displayOption: 6 as DisplayOption }) }),
		config("unclassified", { modelInfo: create(ModelInfoSchema, { displayOption: 7 as DisplayOption }) }),
		config("normal", { modelInfo: create(ModelInfoSchema, { displayOption: 8 as DisplayOption }) }),
		config("no-tools", { modelInfo: featureInfo({ supportsToolCalls: false }) }),
		config(""),
		config("   "),
		config("native", { label: " First " }),
		config("native", { label: "Duplicate" }),
	]);
	assert.deepEqual(models.map(model => model.id), ["native", "normal", "unclassified"]);
	assert.equal(models[0].name, "First");
});

test("native effort UIDs are not collapsed; only a fixed high default is exposed for reasoning", () => {
	const family = create(ModelFamilyMetadataSchema, { modelFamilyLabel: "GPT Test" });
	const models = normalizeDevinModels([
		config("gpt-test-low", { label: "GPT Test Low", modelFamilyMetadata: family, modelInfo: featureInfo({ supportsThinking: true }) }),
		config("gpt-test-high", { label: "GPT Test High", modelFamilyMetadata: family, modelInfo: featureInfo({ supportsThinking: true }) }),
		config("no-thinking", { label: "GPT No Thinking" }),
		config("label-thinking", { label: "GPT Thinking" }),
		config("authoritative", { label: "GPT Thinking", modelInfo: featureInfo({ supportsThinking: false }) }),
	]);
	assert.equal(models.length, 5);
	assert.ok(models.some(model => model.id === "gpt-test-low"));
	assert.ok(models.some(model => model.id === "gpt-test-high"));
	for (const model of models) {
		const reasoning = !["no-thinking", "authoritative"].includes(model.id);
		assert.equal(model.reasoning, reasoning);
		assert.deepEqual(model.thinkingLevelMap, {
			off: null, minimal: null, low: null, medium: null, high: reasoning ? "default" : null, xhigh: null, max: null,
		});
		assert.equal(getModelRoute(model.id).requestModelId, undefined);
	}
});

test("image capabilities honor features, except image-blind SWE-1.6 UIDs", () => {
	const models = normalizeDevinModels([
		config("swe-1-6", { modelInfo: featureInfo({ supportsImages: true }) }),
		config("swe-1-6-fast", { supportsImages: true }),
		config("swe-1-7", { modelInfo: featureInfo({ supportsImages: true }) }),
		config("legacy-images", { supportsImages: true }),
		config("features-win", { supportsImages: true, modelInfo: featureInfo({ supportsImages: false }) }),
	]);
	for (const model of models) {
		assert.deepEqual(model.input, ["swe-1-7", "legacy-images"].includes(model.id) ? ["text", "image"] : ["text"]);
	}
});

test("routers use AssignModel only without harnesses; fusion pairings are never advertised", () => {
	const models = normalizeDevinModels([
		config("adaptive", { modelInfo: create(ModelInfoSchema, { displayOption: DisplayOption.MODEL_ROUTER }) }),
		config("router-flag", { modelInfo: create(ModelInfoSchema, { isModelRouter: true }) }),
		config("fusion", { modelInfo: create(ModelInfoSchema, { isModelRouter: true, harnessUids: ["harness"] }) }),
		config("lead", { modelInfo: featureInfo({ supportsParallelToolCalls: true }) }),
		config("fusion-lead-sidekick-small"),
		config("fusion-missing-sidekick-small"),
	]);
	assert.deepEqual(models.map(model => model.id), ["adaptive", "fusion", "lead", "router-flag"]);
	assert.deepEqual(getModelRoute("adaptive"), { modelRouter: true });
	assert.deepEqual(getModelRoute("router-flag"), { modelRouter: true });
	assert.deepEqual(getModelRoute("fusion"), {});
	assert.deepEqual(getModelRoute("lead"), { supportsParallelToolCalls: true });
	assert.deepEqual(getModelRoute("unknown"), {});
	const route = getModelRoute("adaptive");
	route.modelRouter = false;
	assert.equal(getModelRoute("adaptive").modelRouter, true, "routes must be defensive copies");
});

test("routing metadata survives JSON persistence and takes precedence over later discoveries", () => {
	const [router] = normalizeDevinModels([config("adaptive", {
		modelInfo: create(ModelInfoSchema, { isModelRouter: true }),
	})]);
	const restored = JSON.parse(JSON.stringify(router));
	normalizeDevinModels([]);
	assert.deepEqual(getModelRoute("adaptive"), {});
	assert.deepEqual(getModelRoute("adaptive", restored), { modelRouter: true });
	assert.deepEqual(getModelRoute("persisted", { samplingParams: { devin: {
		modelRouter: false, supportsParallelToolCalls: true, requestModelId: "wire-uid", unrelated: 42,
	} } }), { modelRouter: false, supportsParallelToolCalls: true, requestModelId: "wire-uid" });
	assert.deepEqual(getModelRoute("persisted", { samplingParams: { devin: {
		modelRouter: "true", supportsParallelToolCalls: 1, requestModelId: " ",
	} } }), {});
});

test("cost dimensions normalize denominators, float32 noise and fuzzy prices, stopping at Sidekick", () => {
	const dimension = (label: string, value: number, denominator = "1M tokens", kind = ModelDimensionKind.COST) =>
		create(ModelDimensionSchema, { label, value, denominator, kind });
	const [model] = normalizeDevinModels([config("priced", {
		modelDimensions: [
			dimension(" Input ", 0.002, "1K tokens"),
			dimension("Cached Input", 0.10000000149011612),
			dimension("Output", 8, "2M tokens", ModelDimensionKind.COST_FUZZY),
			dimension("Output", 999, "1M tokens", ModelDimensionKind.UNSPECIFIED),
			dimension("Sidekick", 0, "", ModelDimensionKind.UNSPECIFIED),
			dimension("Input", 100),
			dimension("Output", 100),
		],
	})]);
	assert.deepEqual(model.cost, { input: 2, output: 4, cacheRead: 0.1, cacheWrite: 0 });
	const [other] = normalizeDevinModels([config("other", {
		modelDimensions: [dimension("Input", 2000, "1B tokens"), dimension("Output", 3, "unknown")],
	})]);
	assert.equal(other.cost.input, 2);
	assert.equal(other.cost.output, 3);
});

test("context and output limits are distinct native fields, with positive-only defaults", () => {
	const models = normalizeDevinModels([
		config("explicit", { maxTokens: 1_000_000, modelInfo: create(ModelInfoSchema, { maxTokens: 123, maxOutputTokens: 32_000 }) }),
		config("info-context", { modelInfo: create(ModelInfoSchema, { maxTokens: 128_000 }) }),
		config("defaults", { maxTokens: -1, modelInfo: create(ModelInfoSchema, { maxOutputTokens: -1 }) }),
	]);
	assert.equal(models.find(model => model.id === "explicit")?.contextWindow, 1_000_000);
	assert.equal(models.find(model => model.id === "explicit")?.maxTokens, 32_000);
	assert.equal(models.find(model => model.id === "info-context")?.contextWindow, 128_000);
	assert.equal(models.find(model => model.id === "defaults")?.contextWindow, 200_000);
	assert.equal(models.find(model => model.id === "defaults")?.maxTokens, 64_000);
});
