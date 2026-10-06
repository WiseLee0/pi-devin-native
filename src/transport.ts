import { gunzipSync, gzipSync } from "node:zlib";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { create, toBinary, type MessageCodec, type ProtoMessage } from "./vendor/protobuf.js";
import { GetUserJwtRequestSchema, GetUserJwtResponseSchema, MetadataSchema } from "./vendor/devin-proto.js";
import { decodeDevinUnaryMessage } from "./devin-proto.js";
import { devinCliMetadata, devinWireMetadata } from "./devin.js";

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export type RequestOptions = Pick<SimpleStreamOptions, "fetch" | "signal">;

export function safeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Devin 服务端地址不是有效 URL。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Devin 服务端地址必须使用 HTTPS，且不包含 userinfo、query 或 fragment。");
  }
  return value.replace(/\/+$/, "");
}

export async function httpError(operation: string, response: Response): Promise<Error> {
  // Do not include arbitrary response bodies: they may echo credentials or prompts.
  await response.body?.cancel().catch(() => {});
  const advice = response.status === 401 ? "请重新 /login devin。" : response.status === 403
    ? "账号可能没有 Devin CLI 权限或所选模型权限。" : response.status === 429 ? "请求限流或订阅额度不足。" : "";
  return new Error(`Devin ${operation}: HTTP ${response.status}. ${advice}`);
}

export async function unary<T extends ProtoMessage, R extends ProtoMessage>(
  baseUrl: string, path: string, requestSchema: MessageCodec<T>, responseSchema: MessageCodec<R>,
  request: T, options: RequestOptions = {},
): Promise<R> {
  options.signal?.throwIfAborted();
  const response = await (options.fetch ?? fetch)(safeBaseUrl(baseUrl) + path, {
    method: "POST",
    headers: { "content-type": "application/proto", "connect-protocol-version": "1", accept: "*/*" },
    body: toBinary(requestSchema, request), signal: options.signal, redirect: "error",
  });
  if (!response.ok) throw await httpError(path.split("/").at(-1)!, response);
  const decoded = decodeDevinUnaryMessage(responseSchema, new Uint8Array(await response.arrayBuffer()));
  if (!decoded) throw new Error(`Devin ${path.split("/").at(-1)}: 无法解码 Protobuf 响应。`);
  return decoded;
}

export async function fetchAuth(apiKey: string, baseUrl: string, options: RequestOptions = {}) {
  const path = "/exa.auth_pb.AuthService/GetUserJwt";
  let wireKey = devinCliMetadata(apiKey).apiKey;
  const request = (key: string) => unary(baseUrl, path, GetUserJwtRequestSchema, GetUserJwtResponseSchema,
    create(GetUserJwtRequestSchema, { metadata: create(MetadataSchema, devinWireMetadata(key)) }), options);
  let decoded;
  try { decoded = await request(wireKey); }
  catch (error) {
    if (wireKey !== apiKey && error instanceof Error && error.message.includes("HTTP 401")) {
      wireKey = apiKey;
      decoded = await request(wireKey);
    } else throw error;
  }
  if (!decoded.userJwt) throw new Error("Devin GetUserJwt 返回空 JWT；请重新登录并检查 CLI 权限。");
  const override = decoded.customApiServerUrl.trim();
  return { apiKey: wireKey, userJwt: decoded.userJwt, baseUrl: safeBaseUrl(override || baseUrl) };
}

export function encodeFrame(payload: Uint8Array, compress = true, end = false): Buffer<ArrayBuffer> {
  const body = compress ? gzipSync(payload) : payload;
  const frame = Buffer.alloc(5 + body.length);
  frame[0] = (compress ? 1 : 0) | (end ? 2 : 0);
  frame.writeUInt32BE(body.length, 1);
  frame.set(body, 5);
  return frame;
}

export async function* readFrames(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader();
  let pending: Buffer = Buffer.alloc(0);
  let ended = false;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (value?.length) pending = pending.length ? Buffer.concat([pending, value]) : Buffer.from(value);
      while (pending.length >= 5) {
        const flag = pending[0];
        if (flag & ~3) throw new Error(`Devin Connect: 未知 frame flags ${flag}。`);
        const length = pending.readUInt32BE(1);
        if (length > MAX_FRAME_BYTES) throw new Error("Devin Connect frame 超过 16 MiB 上限。");
        if (pending.length < 5 + length) break;
        if (ended) throw new Error("Devin Connect: trailer 后仍有数据。");
        const payload = pending.subarray(5, 5 + length);
        pending = pending.subarray(5 + length);
        const data = flag & 1 ? gunzipSync(payload, { maxOutputLength: MAX_FRAME_BYTES }) : payload;
        ended = Boolean(flag & 2);
        yield { end: ended, data };
      }
      if (done) break;
    }
    if (pending.length) throw new Error("Devin Connect stream 被截断（不完整 frame）。");
    if (!ended) throw new Error("Devin Connect stream 缺少结束 trailer。");
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
