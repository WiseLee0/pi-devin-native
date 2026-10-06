import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

export const DEVIN_AUTHORIZE_URL = "https://app.devin.ai/auth/cli/continue";
export const DEVIN_TOKEN_URL = "https://api.devin.ai/auth/cli/token";
export const DEVIN_REDIRECT_URI = "http://127.0.0.1:59653/callback";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const OPAQUE_TOKEN_LIFETIME_MS = 31_536_000_000;
const RELOGIN = "Devin credentials have expired or are invalid. Run /login devin again; Devin does not support token refresh.";

export function pkceChallenge(verifier: string): string {
	return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function generateDevinPKCE(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: pkceChallenge(verifier) };
}

/** Mirrors devin.kdl and the OAuth code engine's standard authorize parameters. */
export function buildDevinAuthorizeUrl(state: string, challenge: string): string {
	const url = new URL(DEVIN_AUTHORIZE_URL);
	url.search = new URLSearchParams({
		response_type: "code",
		redirect_uri: DEVIN_REDIRECT_URI,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		prompt: "select_account",
	}).toString();
	return url.toString();
}

function jwtExpiry(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	let claims: unknown;
	try {
		claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
	} catch {
		return undefined; // Opaque tokens are permitted by the catalog rule.
	}
	if (!claims || typeof claims !== "object" || !("exp" in claims)) return undefined;
	const exp = claims.exp;
	if (typeof exp !== "number" || !Number.isFinite(exp) || !Number.isFinite(exp * 1000)) {
		throw new Error("Devin token has an invalid expiration claim. Run /login devin again.");
	}
	// Decoding exp is scheduling only, not JWT signature verification.
	return exp * 1000 - EXPIRY_SKEW_MS;
}

export function credentialsFromDevinToken(body: unknown, now = Date.now()): OAuthCredentials {
	if (!body || typeof body !== "object" || !("token" in body) ||
		typeof body.token !== "string" || !body.token.trim()) {
		throw new Error("Devin token response did not contain a non-empty token.");
	}
	const token = body.token;
	// This fallback is assigned ONLY on initial login, never on refresh.
	const expires = jwtExpiry(token) ?? now + OPAQUE_TOKEN_LIFETIME_MS;
	if (expires <= now) throw new Error(RELOGIN);
	return {
		access: token,
		refresh: token, // Compatibility credential slot; this is NOT a refresh token.
		expires,
		apiEndpoint: "https://api.devin.ai",
		enterpriseUrl: "https://app.devin.ai",
	};
}

function cancelledError(): Error {
	const error = new Error("Devin login cancelled.");
	error.name = "AbortError";
	return error;
}

function checkAbort(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason;
}

/** Also bounds an uncooperative fetch/UI promise without leaking abort listeners. */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	let onAbort: () => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function exchangeCode(
	code: string,
	verifier: string,
	signal: AbortSignal,
	fetchImpl: typeof fetch,
): Promise<OAuthCredentials> {
	checkAbort(signal);
	let response: Response;
	try {
		response = await abortable(fetchImpl(DEVIN_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ code, code_verifier: verifier }),
			redirect: "error",
			signal,
		}), signal);
	} catch {
		checkAbort(signal);
		throw new Error("Devin token exchange failed: network request unsuccessful. Retry /login devin.");
	}
	checkAbort(signal);
	if (!response.ok) {
		// Never expose response bodies, statusText, or underlying fetch errors.
		void response.body?.cancel().catch(() => {});
		throw new Error(`Devin token exchange failed (HTTP ${response.status}). Retry /login devin.`);
	}
	let body: unknown;
	try {
		body = await abortable(response.json(), signal);
	} catch {
		checkAbort(signal);
		throw new Error("Devin token exchange returned invalid JSON.");
	}
	checkAbort(signal);
	return credentialsFromDevinToken(body);
}

export interface DevinLoginOptions {
	/** Test seam: production uses the global fetch and a five-minute deadline. */
	fetch?: typeof fetch;
	timeoutMs?: number;
}

export async function loginDevin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	return loginDevinWithOptions(callbacks);
}

/** Testable flow; endpoint, callback address and port intentionally cannot be overridden. */
export async function loginDevinWithOptions(
	callbacks: OAuthLoginCallbacks,
	options: DevinLoginOptions = {},
): Promise<OAuthCredentials> {
	if (callbacks.signal?.aborted) throw cancelledError();
	const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid Devin login timeout.");
	const controller = new AbortController();
	const { signal } = controller;
	const onExternalAbort = () => controller.abort(cancelledError());
	callbacks.signal?.addEventListener("abort", onExternalAbort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("Devin login timed out. Run /login devin again.")), timeoutMs);
	const state = randomUUID();
	const { verifier, challenge } = generateDevinPKCE();
	let resolveCode!: (code: string) => void;
	let rejectCode!: (error: Error) => void;
	const codePromise = new Promise<string>((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});
	// Server errors can arrive before the flow starts awaiting the callback.
	void codePromise.catch(() => {});
	let received = false;
	const sockets = new Set<Socket>();
	const server = createServer((request, response) => {
		const reply = (status: number, message: string) => {
			response.writeHead(status, {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
			});
			response.end(message);
		};
		if (request.headers.host !== "127.0.0.1:59653") return reply(400, "Invalid callback host.");
		let url: URL;
		try {
			url = new URL(request.url ?? "", DEVIN_REDIRECT_URI);
		} catch {
			return reply(400, "Invalid callback request.");
		}
		if (url.pathname !== "/callback") return reply(404, "Not found.");
		if (request.method !== "GET") return reply(405, "Use GET for the callback.");
		const states = url.searchParams.getAll("state");
		const actualState = Buffer.from(states[0] ?? "");
		const expectedState = Buffer.from(state);
		if (states.length !== 1 || actualState.length !== expectedState.length ||
			!timingSafeEqual(actualState, expectedState)) {
			// An unsolicited request must not consume or cancel the real callback.
			return reply(400, "Invalid OAuth state. Return to the sign-in page.");
		}
		if (received) return reply(409, "Authorization callback already received.");
		if (url.searchParams.has("error")) {
			received = true;
			reply(400, "Authorization failed. Return to Pi and retry login.");
			rejectCode(new Error(url.searchParams.get("error") === "access_denied"
				? "Devin authorization was denied. Run /login devin to retry."
				: "Devin authorization failed. Run /login devin to retry."));
			return;
		}
		const codes = url.searchParams.getAll("code");
		if (codes.length !== 1 || !codes[0]?.trim()) {
			received = true;
			reply(400, "Missing authorization code. Return to Pi and retry login.");
			rejectCode(new Error("Devin callback did not contain a single non-empty authorization code."));
			return;
		}
		received = true;
		reply(200, "Authorization received. You may close this page and return to Pi.");
		resolveCode(codes[0]);
	});
	server.on("connection", socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	const listenError = (error: NodeJS.ErrnoException): Error => new Error(error.code === "EADDRINUSE"
		? "Devin login cannot listen on 127.0.0.1:59653: port already in use. Close the other login or process and retry."
		: "Devin login could not start its callback listener on 127.0.0.1:59653.");
	server.on("error", error => rejectCode(listenError(error)));
	try {
		await abortable(new Promise<void>((resolve, reject) => {
			server.once("error", error => reject(listenError(error)));
			server.listen({ host: "127.0.0.1", port: 59653, signal }, resolve);
		}), signal);
		checkAbort(signal);
		try {
			await abortable(Promise.resolve(callbacks.onAuth({
				url: buildDevinAuthorizeUrl(state, challenge),
				instructions: "Sign in to Devin in your browser.",
			})), signal);
		} catch {
			checkAbort(signal);
			throw new Error("Could not open the Devin authorization page. Retry /login devin.");
		}
		const code = await abortable(codePromise, signal);
		return await exchangeCode(code, verifier, signal, options.fetch ?? fetch);
	} finally {
		clearTimeout(timer);
		callbacks.signal?.removeEventListener("abort", onExternalAbort);
		// Abort outstanding I/O even after success; do not leave an idle listener.
		controller.abort(cancelledError());
		await new Promise<void>(resolve => {
			server.close(() => resolve());
			for (const socket of sockets) socket.destroy();
		});
	}
}

/** No refresh endpoint exists. Return usable credentials unchanged, never extend their expiry. */
export async function refreshDevin(
	credentials: OAuthCredentials,
	signal: AbortSignal,
): Promise<OAuthCredentials> {
	if (signal.aborted) throw cancelledError();
	const now = Date.now();
	if (typeof credentials.access !== "string" || !credentials.access.trim() ||
		!Number.isFinite(credentials.expires) || credentials.expires <= now ||
		(jwtExpiry(credentials.access) ?? credentials.expires) <= now) {
		throw new Error(RELOGIN);
	}
	return credentials;
}
