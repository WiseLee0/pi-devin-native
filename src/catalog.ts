import { isModelType, type Api, type Model, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { DEVIN_DEFAULT_BASE_URL } from "./devin.js";
import { FALLBACK_MODELS, fetchDevinModels, type ProviderChatModelConfig } from "./discovery.js";

/** Restore Pi's provider-scoped cache before startup model selection. */
export function createDevinModelRefresh(): (context: RefreshModelsContext) => Promise<ProviderChatModelConfig[]> {
	let currentModels: ProviderChatModelConfig[] = [...FALLBACK_MODELS];
	return async context => {
		context.signal.throwIfAborted();
		const cached = context.stored?.models.filter((model): model is Model<Api> =>
			isModelType(model, "chat") && model.provider === "devin" && model.api === "devin-native-connect",
		);
		if (cached?.length) {
			await context.publish({ update: () => { currentModels = cached; } });
		}
		if (!context.allowNetwork) return currentModels;
		const key = context.credential?.type === "oauth" ? context.credential.access
			: context.credential?.type === "api_key" ? context.credential.key : undefined;
		const apiKey = key ?? process.env.DEVIN_API_KEY;
		if (!apiKey) return currentModels;
		const models = await fetchDevinModels(apiKey, { signal: context.signal });
		context.signal.throwIfAborted();
		// Only model metadata is persisted, never credentials or raw provider responses.
		await context.publish({
			persist: {
				models: models.map((model): Model<Api> => ({
					...model,
					provider: "devin",
					api: "devin-native-connect",
					baseUrl: model.baseUrl ?? DEVIN_DEFAULT_BASE_URL,
					name: model.name ?? model.id,
					reasoning: model.reasoning ?? false,
					input: model.input ?? ["text"],
					cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: model.contextWindow ?? 200_000,
					maxTokens: model.maxTokens ?? 64_000,
				})),
				checkedAt: Date.now(),
			},
			update: () => { currentModels = models; },
		});
		return currentModels;
	};
}
