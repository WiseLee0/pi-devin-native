import { createHash } from "node:crypto";
import { transformMessages } from "./transform-messages.js";
import {
  collapseSystemMessages, getCurrentSystemPrompt, getCurrentTools,
  type Model, type Api, type Message, type TranscriptContext, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  ChatMessagePromptSchema, ChatMessageSource, ImageDataSchema, ChatToolCallSchema,
  ChatToolDefinitionSchema, ChatToolChoiceSchema, CompletionConfigurationSchema,
  GetChatMessageRequestSchema, MetadataSchema, PromptCacheOptionsSchema,
  CacheControlType, ChatMessageRequestType, ConversationalPlannerMode,
} from "./vendor/devin-proto.js";
import { create } from "./vendor/protobuf.js";
import { devinWireMetadata } from "./devin.js";

export function stableId(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function imageParts(content: Exclude<Message, { role: "assistant" | "system" }> ["content"], model: Model<Api>) {
  return typeof content === "string" || !model.input.includes("image") ? [] : content.filter(p => p.type === "image")
    .map(p => create(ImageDataSchema, { base64Data: p.data, mimeType: p.mimeType }));
}

export function mapMessages(messages: Message[], cascadeId: string, model: Model<Api>) {
  return transformMessages(messages, model).flatMap((msg, index) => {
    if (msg.role === "system") return [];
    const id = stableId(`${cascadeId}\0${index}\0${msg.role}`);
    if (msg.role === "user") return [create(ChatMessagePromptSchema, {
      messageId: id, source: ChatMessageSource.USER,
      prompt: typeof msg.content === "string" ? msg.content : msg.content.filter(p => p.type === "text").map(p => p.text).join("\n"),
      images: imageParts(msg.content, model),
    })];
    if (msg.role === "toolResult") return [create(ChatMessagePromptSchema, {
      messageId: id, source: ChatMessageSource.TOOL, toolCallId: msg.toolCallId,
      toolResultIsError: msg.isError, prompt: msg.content.filter(p => p.type === "text").map(p => p.text).join("\n"),
      images: imageParts(msg.content, model),
    })];
    // Never replay another provider's opaque signatures or thinking as Devin-native reasoning.
    const native = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
    const texts: string[] = [], thoughts: string[] = [];
    let signature = "";
    const calls = [];
    for (const part of msg.content) {
      if (part.type === "text") texts.push(part.text);
      else if (part.type === "thinking") {
        if (native) { thoughts.push(part.thinking); signature ||= part.thinkingSignature ?? ""; }
        else if (part.thinking && !part.redacted) texts.push(part.thinking);
      } else calls.push(create(ChatToolCallSchema, { id: part.id, name: part.name, argumentsJson: JSON.stringify(part.arguments) }));
    }
    if (!texts.length && !thoughts.length && !signature && !calls.length) return [];
    return [create(ChatMessagePromptSchema, {
      messageId: native && msg.responseId ? msg.responseId : `bot-${id}`,
      source: ChatMessageSource.SYSTEM, prompt: texts.join("\n"), thinking: thoughts.join("\n"), signature, toolCalls: calls,
    })];
  });
}

// Gemini rejects JSON-schema type arrays through Cascade, just as through its native API.
export function normalizeGoogleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeGoogleSchema);
  if (!value || typeof value !== "object") return value;
  const object = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeGoogleSchema(v)]));
  if (Array.isArray(object.type)) {
    const types = object.type.filter(t => t !== "null");
    const nullable = object.type.includes("null");
    delete object.type;
    if (types.length === 1) object.type = types[0];
    else object.anyOf = types.map(type => ({ type }));
    if (nullable) object.nullable = true;
  }
  return object;
}

export interface Turn {
  apiKey: string;
  userJwt: string;
  cascadeId: string;
  modelUid: string;
  assignmentJwt?: string;
  supportsParallelToolCalls?: boolean;
}

export function buildChatRequest(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions, turn: Turn) {
  const transcript = collapseSystemMessages(context);
  const google = /gemini|MODEL_GOOGLE_/i.test(turn.modelUid);
  const tools = (options.toolChoice === "none" ? [] : getCurrentTools(transcript.messages)).map(tool => {
    if (tool.constrainedSampling && (tool.constrainedSampling.type === "grammar" || tool.constrainedSampling.strict === "require")) {
      throw new Error(`Devin 暂不支持工具 ${tool.name} 要求的 constrained sampling。`);
    }
    return create(ChatToolDefinitionSchema, {
      name: tool.name, description: tool.description,
      jsonSchemaString: JSON.stringify(google ? normalizeGoogleSchema(tool.parameters) : tool.parameters), strict: false,
    });
  });
  return create(GetChatMessageRequestSchema, {
    metadata: create(MetadataSchema, devinWireMetadata(turn.apiKey, turn.userJwt)),
    prompt: getCurrentSystemPrompt(transcript.messages),
    chatMessagePrompts: mapMessages(transcript.messages, turn.cascadeId, model),
    chatModelUid: turn.modelUid, modelAssignmentJwt: turn.assignmentJwt,
    requestType: ChatMessageRequestType.CASCADE, plannerMode: ConversationalPlannerMode.DEFAULT,
    toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: options.toolChoice ?? "auto" } }),
    systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
    disableParallelToolCalls: !turn.supportsParallelToolCalls,
    cascadeId: turn.cascadeId, executionId: crypto.randomUUID(),
    configuration: create(CompletionConfigurationSchema, {
      numCompletions: 1n, maxTokens: BigInt(options.maxTokens ?? model.maxTokens), maxNewlines: 200n,
      temperature: options.temperature ?? 0.4, firstTemperature: options.temperature ?? 0.4,
      topK: 50n, topP: 1, fimEotProbThreshold: 1,
      stopPatterns: ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"],
    }), tools,
  });
}
