// Native Cascade protocol and delta semantics adapted from oh-my-pi (MIT).
import {
  calculateCost, createAssistantMessageEventStream,
  type Api, type AssistantMessage, type Model, type SimpleStreamOptions, type TranscriptContext,
  type TextContent, type ThinkingContent, type ToolCall, type JsonObject,
} from "@earendil-works/pi-ai";
import {
  GetChatMessageRequestSchema, GetChatMessageResponseSchema, StopReason,
  AssignModelRequestSchema, AssignModelResponseSchema, MetadataSchema,
} from "./vendor/devin-proto.js";
import { create, fromBinary, toBinary } from "./vendor/protobuf.js";
import { DEVIN_DEFAULT_BASE_URL, devinWireMetadata } from "./devin.js";
import { buildChatRequest, mapMessages } from "./messages.js";
import { getModelRoute } from "./discovery.js";
import { encodeFrame, fetchAuth, httpError, readFrames, unary } from "./transport.js";

function toolArguments(text: string): JsonObject {
  const parsed: unknown = JSON.parse(text || "{}");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Devin 工具参数不是 JSON 对象。");
  return parsed as JsonObject;
}

export function streamDevin(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), content: [], stopReason: "pending",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  void (async () => {
    // Apply a whole-request deadline, including auth, assignment and stream reads.
    let timeout: AbortSignal | undefined;
    const secrets: string[] = [];
    let textBlock: TextContent | undefined;
    let thinkingBlock: ThinkingContent | undefined;
    let lastThinkingBlock: ThinkingContent | undefined;
    const tools = new Map<string, { block: ToolCall; json: string; parsedLength: number }>();
    let activeToolId: string | undefined;
    let stop = StopReason.UNSPECIFIED;
    let receivedFrame = false;
    const endText = () => {
      if (textBlock) stream.push({ type: "text_end", contentIndex: output.content.indexOf(textBlock), content: textBlock.text, partial: output });
      textBlock = undefined;
    };
    const endThinking = () => {
      if (thinkingBlock) stream.push({ type: "thinking_end", contentIndex: output.content.indexOf(thinkingBlock), content: thinkingBlock.thinking, partial: output });
      thinkingBlock = undefined;
    };
    try {
      const timeoutMs = options.timeoutMs ?? 10 * 60_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("Devin timeoutMs 必须是 1 到 2147483647 的整数。");
      timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const requestOptions = { fetch: options.fetch, signal };
      const key = options.apiKey ?? options.env?.DEVIN_API_KEY ?? process.env.DEVIN_API_KEY;
      if (!key) throw new Error("请先 /login devin，或设置 DEVIN_API_KEY（Devin CLI session token）。");
      secrets.push(key, key.replace(/^devin-session-token\$/, ""), `devin-session-token$${key}`);
      const auth = await fetchAuth(key, model.baseUrl || DEVIN_DEFAULT_BASE_URL, requestOptions);
      secrets.push(auth.apiKey, auth.userJwt);
      const cascadeId = options.sessionId ?? crypto.randomUUID();
      // Validated route metadata survives catalog persistence; never forward it as sampling parameters.
      const policy = getModelRoute(model.id, model);
      let modelUid = policy.requestModelId ?? model.id;
      let assignmentJwt: string | undefined;
      if (policy.modelRouter) {
        const prompts = mapMessages(context.messages, cascadeId, model);
        const currentPrompt = [...prompts].reverse().find(p => p.source === 1);
        const result = await unary(auth.baseUrl, "/exa.api_server_pb.ApiServerService/AssignModel",
          AssignModelRequestSchema, AssignModelResponseSchema, create(AssignModelRequestSchema, {
            metadata: create(MetadataSchema, devinWireMetadata(auth.apiKey)),
            modelRouterUid: modelUid, cascadeId, chatMessagePrompt: currentPrompt ? { ...currentPrompt, messageId: "" } : undefined,
          }), requestOptions);
        if (!result.assignment?.modelUid || !result.assignment.assignmentJwt) throw new Error("Devin AssignModel 未返回有效模型与 assignment JWT。");
        modelUid = result.assignment.modelUid;
        assignmentJwt = result.assignment.assignmentJwt;
        secrets.push(assignmentJwt);
        output.responseModel = modelUid;
      }
      let request = buildChatRequest(model, context, options, {
        ...auth, cascadeId, modelUid, assignmentJwt, supportsParallelToolCalls: policy.supportsParallelToolCalls,
      });
      // Expose the editable protocol payload, not authentication secrets, to general logging hooks.
      const publicRequest = { ...request, metadata: { ...request.metadata!, apiKey: "", userJwt: "" }, modelAssignmentJwt: undefined };
      const replacement = await options.onPayload?.(publicRequest, model);
      const selected = replacement === undefined ? publicRequest : replacement as typeof request;
      request = { ...selected,
        metadata: create(MetadataSchema, { ...selected.metadata, apiKey: auth.apiKey, userJwt: auth.userJwt }),
        modelAssignmentJwt: assignmentJwt,
      };
      const response = await (options.fetch ?? fetch)(auth.baseUrl + "/exa.api_server_pb.ApiServerService/GetChatMessage", {
        method: "POST", body: encodeFrame(toBinary(GetChatMessageRequestSchema, request)), signal, redirect: "error",
        headers: (() => {
          const headers = new Headers({
            "content-type": "application/connect+proto", "connect-protocol-version": "1",
            "connect-content-encoding": "gzip", "connect-accept-encoding": "gzip", "accept-encoding": "identity",
            "user-agent": "connect-go/1.18.1 (go1.26.3)",
          });
          for (const [key, value] of Object.entries(options.headers ?? {})) {
            if (value === null) headers.delete(key); else headers.set(key, value);
          }
          return headers;
        })(),
      });
      await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
      if (!response.ok) throw await httpError("GetChatMessage", response);
      if (!response.body) throw new Error("Devin 返回空响应 body。");
      stream.push({ type: "start", partial: output });
      for await (const frame of readFrames(response.body, signal)) {
        if (frame.end) {
          const trailer: unknown = JSON.parse(frame.data.toString("utf8") || "{}");
          await options.onProviderStreamEvent?.({ type: "trailer", data: trailer }, model);
          if (!trailer || typeof trailer !== "object" || Array.isArray(trailer)) throw new Error("Devin Connect trailer 格式错误。");
          if ("error" in trailer && trailer.error) {
            const error = trailer.error as { code?: string; message?: string };
            // Generic invalid_argument must NOT be treated as overflow; only explicit context errors qualify.
            const code = typeof error.code === "string" ? error.code : "unknown";
            const message = typeof error.message === "string" ? error.message : "stream error";
            const overflow = /context.{0,30}(?:length|window|limit)|input.{0,20}(?:too long|exceeds)|too many tokens/i.test(message);
            throw new Error(`${overflow ? "context_length_exceeded: " : ""}Devin ${code}: ${message}`);
          }
          continue;
        }
        receivedFrame = true;
        const msg = fromBinary(GetChatMessageResponseSchema, frame.data);
        await options.onProviderStreamEvent?.(msg, model);
        if (msg.messageId) output.responseId ||= msg.messageId;
        if (msg.actualModelUid) output.responseModel = msg.actualModelUid;
        if (msg.deltaThinking) {
          endText();
          if (!thinkingBlock) {
            thinkingBlock = { type: "thinking", thinking: "" };
            lastThinkingBlock = thinkingBlock;
            output.content.push(thinkingBlock);
            stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
          }
          thinkingBlock.thinking += msg.deltaThinking;
          stream.push({ type: "thinking_delta", contentIndex: output.content.indexOf(thinkingBlock), delta: msg.deltaThinking, partial: output });
        }
        if (msg.deltaSignature && lastThinkingBlock) lastThinkingBlock.thinkingSignature = msg.deltaSignature;
        if (msg.thinkingRedacted && lastThinkingBlock) lastThinkingBlock.redacted = true;
        if (msg.deltaText) {
          endThinking();
          if (!textBlock) {
            textBlock = { type: "text", text: "" };
            output.content.push(textBlock);
            stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
          }
          textBlock.text += msg.deltaText;
          stream.push({ type: "text_delta", contentIndex: output.content.indexOf(textBlock), delta: msg.deltaText, partial: output });
        }
        if (msg.deltaToolCalls.length) {
          endText(); endThinking();
          for (const call of msg.deltaToolCalls) {
            const id = call.id || activeToolId;
            if (!id) throw new Error("Devin 工具调用缺少 ID。");
            let entry = tools.get(id);
            if (!entry) {
              entry = { block: { type: "toolCall", id, name: call.name, arguments: {} }, json: "", parsedLength: 0 };
              tools.set(id, entry); output.content.push(entry.block);
              stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
            }
            activeToolId = id;
            if (call.name) entry.block.name = call.name;
            if (!call.argumentsJson) continue;
            const accumulated = call.argumentsJson.startsWith(entry.json) ? call.argumentsJson : entry.json + call.argumentsJson;
            const delta = accumulated.slice(entry.json.length);
            entry.json = accumulated;
            if (entry.json.length > 16 * 1024 * 1024) throw new Error("Devin 工具参数超过 16 MiB 上限。");
            if (entry.json.length >= Math.max(64, entry.parsedLength * 2)) {
              try { entry.block.arguments = toolArguments(entry.json); } catch { /* Final parsing below is mandatory. */ }
              entry.parsedLength = entry.json.length;
            }
            stream.push({ type: "toolcall_delta", contentIndex: output.content.indexOf(entry.block), delta, partial: output });
          }
        }
        if (msg.stopReason === StopReason.ERROR || msg.stopReason === StopReason.NONFINITE_LOGIT_OR_PROB || msg.stopReason === StopReason.CONTENT_FILTER) {
          throw new Error(`Devin 模型生成失败或被过滤（stopReason=${msg.stopReason}）。`);
        }
        if (StopReason[msg.stopReason] === undefined) throw new Error(`Devin 未知 stopReason=${msg.stopReason}。`);
        if (msg.stopReason !== StopReason.UNSPECIFIED) stop = msg.stopReason;
        if (msg.usage) {
          output.usage.input = Number(msg.usage.inputTokens);
          output.usage.output = Number(msg.usage.outputTokens);
          output.usage.cacheRead = Number(msg.usage.cacheReadTokens);
          output.usage.cacheWrite = Number(msg.usage.cacheWriteTokens);
          output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
        }
      }
      signal.throwIfAborted();
      endText(); endThinking();
      if (!receivedFrame) throw new Error("Devin 返回空 stream。");
      if (stop === StopReason.FUNCTION_CALL && !tools.size) throw new Error("Devin 声明工具调用结束但未返回任何工具调用。");
      if (stop === StopReason.UNSPECIFIED || stop === StopReason.INCOMPLETE || stop === StopReason.PARTIAL) {
        throw new Error("Devin stream 未返回有效的终止原因。");
      }
      for (const { block, json } of tools.values()) {
        if (!block.name) throw new Error("Devin 工具调用缺少名称。");
        block.arguments = toolArguments(json);
        stream.push({ type: "toolcall_end", contentIndex: output.content.indexOf(block), toolCall: block, partial: output });
      }
      output.rawStopReason = StopReason[stop];
      output.stopReason = tools.size ? "toolUse" : stop === StopReason.MAX_TOKENS || stop === StopReason.MAX_NEWLINES ? "length" : "stop";
      calculateCost(model, output.usage);
      stream.push({ type: "done", reason: output.stopReason, message: output });
    } catch (error) {
      // Close any open content blocks so observers see balanced content events even on errors.
      endText(); endThinking();
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      let message = options.signal?.aborted ? "Devin 请求已取消。" : timeout?.aborted ? "Devin 请求超时。" : error instanceof Error ? error.message : "Devin 请求失败。";
      for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) message = message.split(secret).join("[REDACTED]");
      output.errorMessage = message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1500);
      stream.push({ type: "error", reason: output.stopReason, error: output });
    } finally { stream.end(); }
  })();
  return stream;
}
