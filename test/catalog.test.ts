import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelsPublication, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { createDevinModelRefresh } from "../src/catalog.js";
import { FALLBACK_MODELS, getModelRoute } from "../src/discovery.js";
import { create, toBinary } from "../src/vendor/protobuf.js";
import { ClientModelConfigSchema, GetCliModelConfigsResponseSchema, ModelInfoSchema } from "../src/vendor/devin-proto.js";

const id = "claude-opus-5-5-medium-fast";
function cached(): ModelsStoreEntry {
	return { models: [{ ...FALLBACK_MODELS[0], id, name: id, provider: "devin", api: "devin-native-connect",
		baseUrl: "https://api.devin.ai", reasoning: true, input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000,
		samplingParams: { devin: { modelRouter: true, supportsParallelToolCalls: true } },
	}] };
}
function context(stored?: ModelsStoreEntry, allowNetwork = false) {
	let persisted = stored;
	const publications: ModelsPublication[] = [];
	const ctx: RefreshModelsContext = {
		stored, allowNetwork, signal: new AbortController().signal,
		credential: { type: "api_key", key: "mock-session-token" },
		async publish(publication) {
			publications.push(publication);
			if (publication.persist) persisted = publication.persist;
			publication.update?.();
			return true;
		},
	};
	return { ctx, publications, stored: () => persisted };
}

test("cache-only startup restores full models and routing metadata without network or writes", async () => {
	const state = context(JSON.parse(JSON.stringify(cached())));
	const models = await createDevinModelRefresh()(state.ctx);
	assert.equal(models[0].id, id);
	assert.deepEqual(models[0].input, ["text", "image"]);
	assert.equal(models[0].cost?.output, 2);
	assert.deepEqual(getModelRoute(id, models[0]), { modelRouter: true, supportsParallelToolCalls: true });
	assert.ok(state.publications.every(publication => publication.persist === undefined));
});

test("missing, empty, or foreign-provider caches keep the SWE boot seed", async () => {
	for (const stored of [undefined, { models: [] }, { models: cached().models.map(model => ({ ...model, provider: "other" })) }]) {
		const models = await createDevinModelRefresh()(context(stored).ctx);
		assert.equal(models[0].id, "swe-1-6");
	}
});

test("successful discovery persists only metadata and survives a new refresh closure", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response(toBinary(GetCliModelConfigsResponseSchema, create(GetCliModelConfigsResponseSchema, {
		clientModelConfigs: [create(ClientModelConfigSchema, {
			modelUid: id, label: "Opus Medium Fast", modelInfo: create(ModelInfoSchema, { isModelRouter: true }),
		})],
	})))) as typeof fetch;
	try {
		const state = context(undefined, true);
		const models = await createDevinModelRefresh()(state.ctx);
		assert.equal(models[0].id, id);
		assert.equal(state.stored()?.models[0].provider, "devin");
		assert.ok(state.stored()?.checkedAt);
		assert.ok(!JSON.stringify(state.stored()).includes("mock-session-token"));
		const restored = await createDevinModelRefresh()(context(state.stored()).ctx);
		assert.equal(restored[0].id, id);
		assert.deepEqual(getModelRoute(id, restored[0]), { modelRouter: true });
	} finally { globalThis.fetch = original; }
});

test("failed discovery reports the error and retains the last good catalog", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
	try {
		const refresh = createDevinModelRefresh();
		const state = context(cached(), true);
		await assert.rejects(refresh(state.ctx), /offline/);
		assert.equal(state.stored()?.models[0].id, id);
		assert.equal((await refresh(context().ctx))[0].id, id);
		assert.ok(state.publications.every(publication => !publication.persist));
	} finally { globalThis.fetch = original; }
});

test("aborted or superseded publications cannot replace the in-memory catalog", async () => {
	const state = context(cached());
	state.ctx.publish = async () => false;
	assert.equal((await createDevinModelRefresh()(state.ctx))[0].id, "swe-1-6");
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(createDevinModelRefresh()({ ...state.ctx, signal: controller.signal }), { name: "AbortError" });
});
