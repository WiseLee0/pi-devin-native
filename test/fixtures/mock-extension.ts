// Test-only extension: never packaged as a Pi entrypoint. No real service access.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import nativeExtension from "../../index.js";
import { gunzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "../../src/vendor/protobuf.js";
import {
  GetUserJwtResponseSchema, GetChatMessageRequestSchema, GetChatMessageResponseSchema,
  ChatToolCallSchema, StopReason,
} from "../../src/vendor/devin-proto.js";
import { encodeFrame } from "../../src/transport.js";

export default function (pi: ExtensionAPI) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("GetUserJwt")) return new Response(toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "mock-jwt" })));
    if (!String(url).endsWith("GetChatMessage")) throw new Error("Test blocked unexpected network request");
    const body = Buffer.from(init!.body as Uint8Array);
    const request = fromBinary(GetChatMessageRequestSchema, gunzipSync(body.subarray(5)));
    const result = request.chatMessagePrompts.find(prompt => prompt.toolCallId === "mock-read-1");
    const reply = result
      ? create(GetChatMessageResponseSchema, { deltaText: result.prompt.includes("native-devin-fixture") ? "MOCK_TOOL_CYCLE_OK" : "MOCK_TOOL_CYCLE_FAILED", stopReason: StopReason.STOP_PATTERN })
      : create(GetChatMessageResponseSchema, { deltaToolCalls: [create(ChatToolCallSchema, {
          id: "mock-read-1", name: "read", argumentsJson: JSON.stringify({ path: process.env.DEVIN_TEST_FIXTURE }),
        })], stopReason: StopReason.FUNCTION_CALL });
    return new Response(Buffer.concat([
      encodeFrame(toBinary(GetChatMessageResponseSchema, reply)),
      encodeFrame(Buffer.from("{}"), false, true),
    ]));
  }) as typeof fetch;
  nativeExtension(pi);
}
