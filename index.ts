import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
type ProviderChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;
import { DEVIN_DEFAULT_BASE_URL } from "./src/devin.js";
import { FALLBACK_MODELS, fetchDevinModels } from "./src/discovery.js";
import { loginDevin, refreshDevin } from "./src/oauth.js";
import { streamDevin } from "./src/stream.js";

export default function (pi: ExtensionAPI) {
  let currentModels: ProviderChatModelConfig[] = [...FALLBACK_MODELS];
  pi.registerProvider("devin", {
    name: "Devin Native CLI",
    baseUrl: DEVIN_DEFAULT_BASE_URL,
    api: "devin-native-connect",
    apiKey: "$DEVIN_API_KEY",
    models: currentModels,
    oauth: {
      name: "Devin Native CLI",
      isSubscription: true,
      login: loginDevin,
      refreshToken: refreshDevin,
      getApiKey: credentials => credentials.access,
    },
    streamSimple: streamDevin,
    async refreshModels(context) {
      if (!context.allowNetwork) return currentModels;
      const key = context.credential?.type === "oauth" ? context.credential.access
        : context.credential?.type === "api_key" ? context.credential.key : undefined;
      const apiKey = key ?? process.env.DEVIN_API_KEY;
      if (!apiKey) return currentModels;
      const models = await fetchDevinModels(apiKey, { signal: context.signal });
      context.signal.throwIfAborted();
      currentModels = models;
      return currentModels;
    },
  });
  pi.registerCommand("devin-refresh", {
    description: "刷新当前 Devin 账号可用的 CLI 模型",
    handler: async (_args, ctx) => {
      if (!await ctx.modelRegistry.getProviderAuth("devin")) {
        ctx.ui.notify("请先 /login devin。", "warning");
        return;
      }
      const result = await ctx.modelRegistry.refresh({ providers: ["devin"], force: true });
      const error = result.errors.get("devin");
      if (error) ctx.ui.notify(error.message, "error");
      else if (result.aborted) ctx.ui.notify("Devin 模型刷新已取消。", "warning");
      else ctx.ui.notify("Devin 模型刷新完成；使用 /model 选择。", "info");
    },
  });
}
