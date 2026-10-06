import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDevinModelRefresh } from "./src/catalog.js";
import { DEVIN_DEFAULT_BASE_URL } from "./src/devin.js";
import { FALLBACK_MODELS } from "./src/discovery.js";
import { loginDevin, refreshDevin } from "./src/oauth.js";
import { streamDevin } from "./src/stream.js";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("devin", {
    name: "Devin Native CLI",
    baseUrl: DEVIN_DEFAULT_BASE_URL,
    api: "devin-native-connect",
    apiKey: "$DEVIN_API_KEY",
    models: [...FALLBACK_MODELS],
    oauth: {
      name: "Devin Native CLI",
      isSubscription: true,
      login: loginDevin,
      refreshToken: refreshDevin,
      getApiKey: credentials => credentials.access,
    },
    streamSimple: streamDevin,
    refreshModels: createDevinModelRefresh(),
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
