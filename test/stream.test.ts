import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { normalizeContext, type Api, type Model, type SimpleStreamOptions, type Tool } from "@earendil-works/pi-ai";
import { streamDevin } from "../src/stream.js";
import { create, fromBinary, toBinary } from "../src/vendor/protobuf.js";
import {
  GetChatMessageRequestSchema, GetChatMessageResponseSchema, GetUserJwtResponseSchema,
  GetUserJwtRequestSchema, StopReason, ChatToolCallSchema, ModelUsageStatsSchema,
  AssignModelRequestSchema, AssignModelResponseSchema, ModelAssignmentSchema,
} from "../src/vendor/devin-proto.js";
import { encodeFrame, readFrames, MAX_FRAME_BYTES, safeBaseUrl, fetchAuth } from "../src/transport.js";
import { buildChatRequest, mapMessages, stableId, normalizeGoogleSchema } from "../src/messages.js";

const model: Model<Api> = {
  type: "chat", id: "swe-1-6", name: "SWE-1.6", provider: "devin", api: "devin-native-connect",
  baseUrl: "https://server.codeium.com", reasoning: true, input: ["text"],
  contextWindow: 200000, maxTokens: 128000,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
};
const context = normalizeContext({ messages: [{ role: "user", content: "你好", timestamp: 1 }], systemPrompt: "System instructions" });
const wireMsg = (value: Parameters<typeof GetChatMessageResponseSchema.create>[0]) => encodeFrame(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, value)));
const trailer = (value: unknown = {}) => encodeFrame(Buffer.from(JSON.stringify(value)), false, true);
function responseBody(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({ start(controller) { for (const c of chunks) controller.enqueue(c); controller.close(); } });
}
function fetchMock(frames: Uint8Array[], inspect?: (request: ReturnType<typeof GetChatMessageRequestSchema.create>) => void): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("GetUserJwt")) {
      const req = fromBinary(GetUserJwtRequestSchema, new Uint8Array(init!.body as Uint8Array));
      assert.equal(req.metadata?.apiKey, "devin-session-token$test-secret");
      assert.equal(req.metadata?.ideType, "chisel");
      return new Response(toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "user-jwt" })));
    }
    assert.ok(path.endsWith("GetChatMessage"));
    const body = Buffer.from(init!.body as Uint8Array);
    const request = fromBinary(GetChatMessageRequestSchema, gunzipSync(body.subarray(5)));
    assert.equal(request.metadata?.userJwt, "user-jwt");
    inspect?.(request);
    return new Response(responseBody(frames), { headers: { "x-test": "yes" } });
  }) as typeof fetch;
}
async function run(frames: Uint8Array[], options: SimpleStreamOptions = {}) {
  const stream = streamDevin(model, context, { apiKey: "test-secret", fetch: fetchMock(frames), ...options });
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

test("native auth, compressed fragmented stream, Unicode, instrumentation, usage", async () => {
  const frames = Buffer.concat([
    wireMsg({ deltaThinking: "分析", deltaSignature: "sig", messageId: "bot-1" }),
    wireMsg({ deltaText: "你好 🌍", stopReason: StopReason.STOP_PATTERN, actualModelUid: "upstream",
      usage: create(ModelUsageStatsSchema, { inputTokens: 10n, outputTokens: 5n, cacheReadTokens: 2n, cacheWriteTokens: 1n }) }), trailer(),
  ]);
  const fragments = Array.from({ length: Math.ceil(frames.length / 3) }, (_, i) => frames.subarray(i * 3, i * 3 + 3));
  let payloadCalled = false, responseCalled = false, nativeEvents = 0;
  const { events, message } = await run(fragments, {
    onPayload(payload) { payloadCalled = true; return { ...(payload as object), prompt: "replaced" }; },
    onResponse(response) { responseCalled = true; assert.equal(response.headers["x-test"], "yes"); },
    onProviderStreamEvent() { nativeEvents++; },
    fetch: fetchMock(fragments, request => { assert.equal(request.prompt, "replaced"); assert.equal(request.configuration?.temperature, 0.4); }),
  });
  assert.equal(message.stopReason, "stop");
  assert.equal(message.responseId, "bot-1");
  assert.equal(message.responseModel, "upstream");
  assert.deepEqual(message.content, [{ type: "thinking", thinking: "分析", thinkingSignature: "sig" }, { type: "text", text: "你好 🌍" }]);
  assert.equal(message.usage.totalTokens, 18);
  assert.ok(Math.abs(message.usage.cost.input - 0.00001) < 1e-12);
  assert.equal(events[0].type, "start"); assert.equal(events.at(-1)?.type, "done");
  assert.ok(payloadCalled && responseCalled); assert.equal(nativeEvents, 3);
});

test("cumulative and incremental tool JSON plus continuation IDs", async () => {
  const { events, message } = await run([
    wireMsg({ deltaToolCalls: [create(ChatToolCallSchema, { id: "call-1", name: "bash", argumentsJson: '{"command":' })] }),
    wireMsg({ deltaToolCalls: [create(ChatToolCallSchema, { argumentsJson: '{"command":"pwd"}' })], stopReason: StopReason.FUNCTION_CALL }), trailer(),
  ]);
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(message.content[0], { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } });
  assert.equal(events.filter(e => e.type === "toolcall_end").length, 1);
  const incremental = await run([
    wireMsg({ deltaToolCalls: [create(ChatToolCallSchema, { id: "call-2", name: "read", argumentsJson: '{"path":' })] }),
    wireMsg({ deltaToolCalls: [create(ChatToolCallSchema, { argumentsJson: '"README.md"}' })], stopReason: StopReason.FUNCTION_CALL }), trailer(),
  ]);
  assert.equal(incremental.message.stopReason, "toolUse");
});

test("invalid tool JSON fails rather than executing wrong arguments", async () => {
  const { message } = await run([wireMsg({ deltaToolCalls: [create(ChatToolCallSchema, { id: "bad", name: "bash", argumentsJson: '{"command":' })], stopReason: StopReason.FUNCTION_CALL }), trailer()]);
  assert.equal(message.stopReason, "error");
});

test("normal tool results, native signatures, cross-provider handoff and stable message IDs", () => {
  const mapped = mapMessages([
    { role: "user", content: "hello", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "thought", thinkingSignature: "signature" }],
      api: model.api, provider: "devin", model: model.id, usage: zeroUsage(), stopReason: "stop", timestamp: 2, responseId: "native-bot" },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
    { role: "assistant", content: [{ type: "thinking", thinking: "foreign", thinkingSignature: "never-replay" }],
      api: "anthropic-messages", provider: "anthropic", model: "claude", usage: zeroUsage(), stopReason: "stop", timestamp: 4 },
  ], "session", model);
  assert.equal(mapped[1].messageId, "native-bot"); assert.equal(mapped[1].signature, "signature");
  assert.equal(mapped[2].toolCallId, "c1"); assert.equal(mapped[2].source, 4);
  assert.equal(mapped[3].signature, ""); assert.equal(mapped[3].prompt, "foreign");
  assert.equal(stableId("seed"), stableId("seed"));
});
function zeroUsage() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }

test("request extracts prompt/tools from normalized transcript, drops unsupported images", () => {
  const tool = { name: "bash", description: "Shell", parameters: { type: "object", properties: { command: { type: "string" } } } } as Tool;
  const request = buildChatRequest(model, normalizeContext({ systemPrompt: "system", tools: [tool], messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 }] }), {},
    { apiKey: "key", userJwt: "jwt", cascadeId: "c", modelUid: model.id });
  assert.equal(request.prompt, "system"); assert.equal(request.tools[0].name, "bash");
  assert.equal(request.chatMessagePrompts[0].images.length, 0);
  assert.deepEqual(normalizeGoogleSchema({ type: ["number", "null"] }), { type: "number", nullable: true });
});

test("trailer errors distinguish context overflow from generic invalid_argument", async () => {
  const overflow = await run([trailer({ error: { code: "invalid_argument", message: "input exceeds context window" } })]);
  assert.match(overflow.message.errorMessage!, /^context_length_exceeded:/);
  const generic = await run([trailer({ error: { code: "invalid_argument", message: "an internal error occurred" } })]);
  assert.equal(generic.message.stopReason, "error"); assert.ok(!generic.message.errorMessage?.includes("context_length_exceeded"));
});

test("empty, incomplete, truncated and missing-terminal streams are rejected", async () => {
  for (const frames of [[], [trailer()], [wireMsg({ deltaText: "partial" })], [wireMsg({ deltaText: "partial" }), trailer()], [wireMsg({ deltaText: "partial" }).subarray(0, 8)]]) {
    const { message } = await run(frames);
    assert.equal(message.stopReason, "error");
  }
});

test("length stop and native error stop", async () => {
  assert.equal((await run([wireMsg({ deltaText: "long", stopReason: StopReason.MAX_TOKENS }), trailer()])).message.stopReason, "length");
  assert.equal((await run([wireMsg({ stopReason: StopReason.ERROR }), trailer()])).message.stopReason, "error");
});

test("frame cap rejects malicious header before allocating advertised payload", async () => {
  const header = Buffer.alloc(5); header.writeUInt32BE(MAX_FRAME_BYTES + 1, 1);
  await assert.rejects(async () => { for await (const _frame of readFrames(responseBody([header]))) { /* no-op */ } }, /16 MiB/);
});

test("AbortSignal produces aborted terminal event and cancels reader", async () => {
  const controller = new AbortController(); let cancelled = false;
  const hanging = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(wireMsg({ deltaText: "started" })); }, cancel() { cancelled = true; } });
  const mock = fetchMock([]);
  const customFetch = (async (url: string | URL | Request, init?: RequestInit) => String(url).endsWith("GetChatMessage") ? new Response(hanging) : mock(url, init)) as typeof fetch;
  const stream = streamDevin(model, context, { apiKey: "test-secret", fetch: customFetch, signal: controller.signal });
  const events = [];
  for await (const event of stream) { events.push(event); if (event.type === "text_delta") controller.abort(); }
  assert.equal((await stream.result()).stopReason, "aborted"); assert.ok(cancelled);
  assert.equal(events.at(-1)?.type, "error");
});

test("HTTP auth errors do not expose response body or secrets", async () => {
  const { message } = await run([], { fetch: (async () => new Response("echoed-private-token", { status: 403 })) as typeof fetch });
  assert.equal(message.stopReason, "error"); assert.match(message.errorMessage!, /CLI 权限/);
  assert.ok(!message.errorMessage?.includes("echoed-private-token"));
});


test("payload hook never receives auth secrets and replacements retain private auth", async () => {
  const frames = [wireMsg({ deltaText: "OK", stopReason: StopReason.STOP_PATTERN }), trailer()];
  const { message } = await run(frames, {
    onPayload(payload) {
      const text = JSON.stringify(payload, (_, v) => typeof v === "bigint" ? String(v) : v);
      assert.ok(!text.includes("test-secret")); assert.ok(!text.includes("user-jwt"));
      return { ...(payload as object), prompt: "sanitized-hook" };
    },
    fetch: fetchMock(frames, request => {
      assert.equal(request.metadata?.apiKey, "devin-session-token$test-secret");
      assert.equal(request.metadata?.userJwt, "user-jwt"); assert.equal(request.prompt, "sanitized-hook");
    }),
  });
  assert.equal(message.stopReason, "stop");
});

test("invalid timeouts terminate stream without unhandled rejection", async () => {
  for (const timeoutMs of [-1, NaN, 0, 0.5, Infinity]) {
    const { message } = await run([], { timeoutMs });
    assert.equal(message.stopReason, "error"); assert.match(message.errorMessage!, /timeoutMs/);
  }
});

test("server errors are redacted before being persisted", async () => {
  const { message } = await run([trailer({ error: { code: "internal", message: "echo devin-session-token$test-secret test-secret user-jwt" } })]);
  assert.equal(message.stopReason, "error");
  assert.ok(!message.errorMessage?.includes("test-secret")); assert.ok(!message.errorMessage?.includes("user-jwt"));
  assert.match(message.errorMessage!, /REDACTED/);
});

test("toolChoice none removes tools and is carried to the native request", () => {
  const tool = { name: "bash", description: "Shell", parameters: { type: "object" } } as Tool;
  const request = buildChatRequest(model, normalizeContext({ systemPrompt: "sys", tools: [tool], messages: [] }), { toolChoice: "none" },
    { apiKey: "key", userJwt: "jwt", cascadeId: "c", modelUid: model.id });
  assert.deepEqual(request.tools, []);
  assert.deepEqual(request.toolChoice?.choice, { case: "optionName", value: "none" });
});

test("failed turns are omitted and orphaned tools receive synthetic results", () => {
  const assistant = { role: "assistant" as const, api: model.api, provider: "devin", model: model.id, usage: zeroUsage(), timestamp: 1,
    content: [{ type: "toolCall" as const, id: "missing-result", name: "read", arguments: { path: "x" } }] };
  const failed = mapMessages([{ ...assistant, stopReason: "error" }], "session", model);
  assert.deepEqual(failed, []);
  const orphaned = mapMessages([{ ...assistant, stopReason: "toolUse" }], "session", model);
  assert.equal(orphaned.length, 2); assert.equal(orphaned[1].toolCallId, "missing-result"); assert.equal(orphaned[1].toolResultIsError, true);
});

test("error stop cannot be overwritten, unknown stops and missing tool calls reject", async () => {
  for (const frames of [
    [wireMsg({ stopReason: StopReason.ERROR }), wireMsg({ deltaText: "wrong success", stopReason: StopReason.STOP_PATTERN }), trailer()],
    [wireMsg({ stopReason: 999 as StopReason }), trailer()],
    [wireMsg({ stopReason: StopReason.FUNCTION_CALL }), trailer()],
  ]) assert.equal((await run(frames)).message.stopReason, "error");
});

test("base URL validation prevents cleartext and URL-embedded credentials", () => {
  for (const url of ["http://example.com", "https://secret@example.com", "https://example.com?token=secret", "https://example.com#secret"])
    assert.throws(() => safeBaseUrl(url));
  assert.equal(safeBaseUrl("https://tenant.example/api/"), "https://tenant.example/api");
});

test("auth retries unprefixed API key only on HTTP 401", async () => {
  let calls = 0;
  const auth = await fetchAuth("raw-key", model.baseUrl, { fetch: (async (_url: unknown, init?: RequestInit) => {
    const request = fromBinary(GetUserJwtRequestSchema, new Uint8Array(init!.body as Uint8Array));
    calls++;
    assert.equal(init?.redirect, "error");
    if (calls === 1) { assert.equal(request.metadata?.apiKey, "devin-session-token$raw-key"); return new Response(null, { status: 401 }); }
    assert.equal(request.metadata?.apiKey, "raw-key");
    return new Response(toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt", customApiServerUrl: "https://tenant.example" })));
  }) as typeof fetch });
  assert.equal(calls, 2); assert.equal(auth.apiKey, "raw-key"); assert.equal(auth.baseUrl, "https://tenant.example");
});

test("router assignment JWT and cascadeId are shared by native AssignModel and chat", async () => {
  let assignedCascadeId = "";
  const normalFetch = fetchMock([wireMsg({ deltaText: "router OK", stopReason: StopReason.STOP_PATTERN }), trailer()], request => {
    assert.equal(request.cascadeId, assignedCascadeId); assert.equal(request.chatModelUid, "assigned-uid");
    assert.equal(request.modelAssignmentJwt, "private-assignment-jwt");
  });
  const routerFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith("AssignModel")) return normalFetch(url, init);
    const request = fromBinary(AssignModelRequestSchema, new Uint8Array(init!.body as Uint8Array));
    assert.equal(request.modelRouterUid, "adaptive"); assert.equal(request.metadata?.ideType, "chisel");
    assignedCascadeId = request.cascadeId;
    return new Response(toBinary(AssignModelResponseSchema, create(AssignModelResponseSchema, {
      assignment: create(ModelAssignmentSchema, { modelUid: "assigned-uid", assignmentJwt: "private-assignment-jwt" }),
    })));
  }) as typeof fetch;
  const stream = streamDevin({ ...model, id: "adaptive", samplingParams: { devin: { modelRouter: true } } }, context, {
    apiKey: "test-secret", fetch: routerFetch, sessionId: "stable-cascade-id",
    onPayload(payload) { assert.equal((payload as { modelAssignmentJwt?: string }).modelAssignmentJwt, undefined); },
  });
  for await (const _event of stream) { /* drain */ }
  const message = await stream.result();
  assert.equal(message.stopReason, "stop"); assert.equal(message.responseModel, "assigned-uid"); assert.equal(assignedCascadeId, "stable-cascade-id");
});
