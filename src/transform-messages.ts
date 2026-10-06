// Adapted from Pi 1.0.4's api/transform-messages (MIT, Mario Zechner).
// Keep this small adapter local: Pi's extension alias maps the root pi-ai import,
// but cannot reliably resolve pi-ai/api/* from a dependency-free packed extension.
import type { Api, AssistantMessage, ImageContent, Message, Model, TextContent, ToolCall } from "@earendil-works/pi-ai";

type AssistantContent = AssistantMessage["content"][number];

function replaceImages(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
  const result: TextContent[] = [];
  let lastWasPlaceholder = false;
  for (const part of content) {
    if (part.type === "image") {
      if (!lastWasPlaceholder) result.push({ type: "text", text: placeholder });
      lastWasPlaceholder = true;
    } else {
      result.push(part);
      lastWasPlaceholder = part.text === placeholder;
    }
  }
  return result;
}

/** Preserve valid native turns, downgrade unsupported images/thinking, and close orphaned tools. */
export function transformMessages(messages: Message[], model: Model<Api>): Message[] {
  const transformed: Message[] = messages.map(msg => {
    if (!model.input.includes("image")) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        return { ...msg, content: replaceImages(msg.content, "(image omitted: model does not support images)") };
      }
      if (msg.role === "toolResult") {
        return { ...msg, content: replaceImages(msg.content, "(tool image omitted: model does not support images)") };
      }
    }
    if (msg.role !== "assistant") return msg;
    const native = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
    const content: AssistantContent[] = msg.content.flatMap((part): AssistantContent[] => {
      if (part.type === "thinking") {
        if (part.redacted) return native ? [part] : [];
        if (native && part.thinkingSignature) return [part];
        if (!part.thinking.trim()) return [];
        return native ? [part] : [{ type: "text", text: part.thinking }];
      }
      if (part.type === "text") return native ? [part] : [{ type: "text", text: part.text }];
      if (!native && part.thoughtSignature) {
        const { thoughtSignature: _signature, ...call } = part;
        return [call];
      }
      return [part];
    });
    return { ...msg, content };
  });

  const result: Message[] = [];
  let pending: ToolCall[] = [];
  let answered = new Set<string>();
  const heldSystem: Message[] = [];
  const closePending = () => {
    for (const call of pending) {
      if (!answered.has(call.id)) result.push({
        role: "toolResult", toolCallId: call.id, toolName: call.name,
        content: [{ type: "text", text: "No result provided" }], isError: true, timestamp: Date.now(),
      });
    }
    pending = [];
    answered = new Set();
    result.push(...heldSystem);
    heldSystem.length = 0;
  };
  for (const msg of transformed) {
    if (msg.role === "assistant") {
      closePending();
      if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
      pending = msg.content.filter((part): part is ToolCall => part.type === "toolCall");
      result.push(msg);
    } else if (msg.role === "toolResult") {
      answered.add(msg.toolCallId);
      result.push(msg);
    } else if (msg.role === "system") {
      if (pending.length) heldSystem.push(msg); else result.push(msg);
    } else {
      closePending();
      result.push(msg);
    }
  }
  closePending();
  return result;
}
