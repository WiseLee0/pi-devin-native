import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { get } from "node:http";
import { test } from "node:test";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
	DEVIN_AUTHORIZE_URL,
	DEVIN_REDIRECT_URI,
	DEVIN_TOKEN_URL,
	buildDevinAuthorizeUrl,
	credentialsFromDevinToken,
	generateDevinPKCE,
	loginDevin,
	loginDevinWithOptions,
	pkceChallenge,
	refreshDevin,
} from "../src/oauth.js";

const SECRET = "secret-that-must-never-appear-in-diagnostics";
const jwt = (claims: unknown) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const idleFetch: typeof fetch = async () => { throw new Error("Token endpoint should not be called"); };

function callbacks(onAuth: OAuthLoginCallbacks["onAuth"], signal?: AbortSignal): OAuthLoginCallbacks {
	return {
		onAuth,
		onDeviceCode: () => { throw new Error("Unexpected device code"); },
		onPrompt: async () => { throw new Error("Unexpected manual prompt"); },
		onSelect: async () => { throw new Error("Unexpected select prompt"); },
		signal,
	};
}

function callbackUrl(authorizeUrl: string, code = "test-code"): URL {
	const url = new URL(DEVIN_REDIRECT_URI);
	url.searchParams.set("state", new URL(authorizeUrl).searchParams.get("state")!);
	url.searchParams.set("code", code);
	return url;
}

async function listen(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(59653, "127.0.0.1", resolve);
	});
}

async function close(server: Server): Promise<void> {
	await new Promise<void>(resolve => server.close(() => resolve()));
}

async function assertPortReleased(): Promise<void> {
	const server = createServer();
	await listen(server);
	await close(server);
}

async function localRequest(url: URL, host?: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = get(url, { agent: false, headers: host ? { Host: host } : {} }, response => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", chunk => { body += chunk; });
			response.on("end", () => resolve({ status: response.statusCode!, body }));
		});
		request.on("error", reject);
	});
}

function assertSafe(error: unknown, pattern: RegExp): boolean {
	assert.ok(error instanceof Error);
	assert.match(error.message, pattern);
	assert.ok(!error.message.includes(SECRET));
	assert.equal(error.cause, undefined);
	return true;
}

test("module import does not start a listener; PKCE follows RFC 7636 S256", async () => {
	await assertPortReleased();
	assert.equal(
		pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
		"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
	);
	const first = generateDevinPKCE();
	const second = generateDevinPKCE();
	assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/);
	assert.match(first.challenge, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(first.challenge, pkceChallenge(first.verifier));
	assert.notEqual(first.verifier, second.verifier);
});

test("authorize query exactly matches the native engine, without invented client or scope", () => {
	const url = new URL(buildDevinAuthorizeUrl("uuid-state", "challenge"));
	assert.equal(url.origin + url.pathname, DEVIN_AUTHORIZE_URL);
	assert.deepEqual(Object.fromEntries(url.searchParams), {
		response_type: "code",
		redirect_uri: "http://127.0.0.1:59653/callback",
		code_challenge: "challenge",
		code_challenge_method: "S256",
		state: "uuid-state",
		prompt: "select_account",
	});
});

test("credentials use token for both slots, JWT expiry with catalog skew, initial opaque fallback", () => {
	const now = 1_700_000_000_000;
	const token = jwt({ exp: now / 1000 + 3600 });
	assert.deepEqual(credentialsFromDevinToken({ token }, now), {
		access: token,
		refresh: token,
		expires: now + 3_600_000 - 300_000,
		apiEndpoint: "https://api.devin.ai",
		enterpriseUrl: "https://app.devin.ai",
	});
	for (const token of ["opaque", "devin-session-token$opaque", "a.not-json.b", jwt({ sub: "user" })]) {
		assert.equal(credentialsFromDevinToken({ token }, now).expires, now + 31_536_000_000);
	}
	for (const body of [null, [], {}, { token: "" }, { token: " " }, { token: 42 }, { access_token: SECRET }]) {
		assert.throws(() => credentialsFromDevinToken(body, now), error => assertSafe(error, /non-empty token/));
	}
	assert.throws(() => credentialsFromDevinToken({ token: jwt({ exp: now / 1000 - 1 }) }, now), /login devin/);
	assert.throws(() => credentialsFromDevinToken({ token: jwt({ exp: "invalid" }) }, now), /invalid expiration/);
});

test("loopback success validates UUID state and PKCE and exchanges JSON code/verifier only", async () => {
	let authUrl = "";
	let exchangeCount = 0;
	const tokenFetch: typeof fetch = async (input, init) => {
		exchangeCount++;
		assert.equal(input, DEVIN_TOKEN_URL);
		assert.equal(init?.method, "POST");
		assert.equal(init?.redirect, "error");
		assert.deepEqual(init?.headers, { "Content-Type": "application/json", Accept: "application/json" });
		assert.ok(init?.signal instanceof AbortSignal);
		assert.equal(init.signal.aborted, false);
		const body = JSON.parse(init.body as string);
		assert.deepEqual(Object.keys(body).sort(), ["code", "code_verifier"]);
		assert.equal(body.code, SECRET);
		assert.equal(pkceChallenge(body.code_verifier), new URL(authUrl).searchParams.get("code_challenge"));
		assert.notEqual(body.code_verifier, new URL(authUrl).searchParams.get("state"));
		return Response.json({ token: "opaque-session-token" });
	};
	const credentials = await loginDevinWithOptions(callbacks(async info => {
		authUrl = info.url;
		assert.match(new URL(authUrl).searchParams.get("state")!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		const url = callbackUrl(authUrl, SECRET);
		const reply = await localRequest(url);
		assert.equal(reply.status, 200);
		assert.ok(!reply.body.includes(SECRET));
	}), { fetch: tokenFetch, timeoutMs: 2000 });
	assert.equal(credentials.access, "opaque-session-token");
	assert.equal(exchangeCount, 1);
	await assertPortReleased();
});

test("unrelated, wrong-host, wrong-method, missing/mismatched/duplicate state cannot consume login", async () => {
	let exchangeCount = 0;
	await loginDevinWithOptions(callbacks(async ({ url: authUrl }) => {
		const valid = callbackUrl(authUrl);
		const unknown = new URL(valid); unknown.pathname = "/other";
		assert.equal((await localRequest(unknown)).status, 404);
		assert.equal((await localRequest(valid, "evil.example:59653")).status, 400);
		assert.equal((await fetch(valid, { method: "POST" })).status, 405);
		const missing = new URL(valid); missing.searchParams.delete("state");
		assert.equal((await localRequest(missing)).status, 400);
		const wrong = new URL(valid); wrong.searchParams.set("state", SECRET);
		assert.equal((await localRequest(wrong)).status, 400);
		const duplicate = new URL(valid); duplicate.searchParams.append("state", valid.searchParams.get("state")!);
		assert.equal((await localRequest(duplicate)).status, 400);
		assert.equal((await localRequest(valid)).status, 200);
		assert.equal((await localRequest(valid)).status, 409);
	}), {
		fetch: async () => { exchangeCount++; return Response.json({ token: "opaque" }); },
		timeoutMs: 2000,
	});
	assert.equal(exchangeCount, 1);
	await assertPortReleased();
});

test("authenticated authorization errors and missing/duplicate code fail safely and release listener", async () => {
	for (const kind of ["denied", "other-error", "no-code", "duplicate-code"]) {
		await assert.rejects(loginDevinWithOptions(callbacks(async ({ url: authUrl }) => {
			const url = callbackUrl(authUrl);
			if (kind === "denied" || kind === "other-error") {
				url.searchParams.set("error", kind === "denied" ? "access_denied" : SECRET);
				url.searchParams.set("error_description", SECRET);
			} else if (kind === "no-code") url.searchParams.delete("code");
			else url.searchParams.append("code", SECRET);
			const reply = await localRequest(url);
			assert.equal(reply.status, 400);
			assert.ok(!reply.body.includes(SECRET));
		}), { fetch: idleFetch, timeoutMs: 2000 }), error => assertSafe(error, /authorization|authorization code/));
		await assertPortReleased();
	}
});

test("HTTP, network, malformed JSON and missing-token failures never expose response secrets", async () => {
	const cases: Array<[typeof fetch, RegExp]> = [
		[async () => new Response(SECRET, { status: 401, statusText: SECRET }), /HTTP 401/],
		[async () => { throw new Error(SECRET); }, /network request unsuccessful/],
		[async () => new Response(SECRET), /invalid JSON/],
		[async () => Response.json({ message: SECRET }), /non-empty token/],
	];
	for (const [tokenFetch, pattern] of cases) {
		await assert.rejects(loginDevinWithOptions(callbacks(async info => {
			await localRequest(callbackUrl(info.url));
		}), { fetch: tokenFetch, timeoutMs: 2000 }), error => assertSafe(error, pattern));
		await assertPortReleased();
	}
});

test("occupied fixed port fails before onAuth, without fallback or closing the other server", async () => {
	const other = createServer((_request, response) => response.end("other"));
	await listen(other);
	try {
		await assert.rejects(loginDevinWithOptions(callbacks(() => assert.fail("onAuth must not run")), {
			fetch: idleFetch,
			timeoutMs: 2000,
		}), /127\.0\.0\.1:59653: port already in use/);
		assert.equal((await localRequest(new URL(DEVIN_REDIRECT_URI))).body, "other");
	} finally {
		await close(other);
	}
	await assertPortReleased();
});

test("pre-aborted login never binds or opens browser and does not leak abort reason", async () => {
	const controller = new AbortController();
	controller.abort(new Error(SECRET));
	await assert.rejects(loginDevin(callbacks(() => assert.fail("onAuth must not run"), controller.signal)), error => {
		assertSafe(error, /cancelled/);
		assert.equal((error as Error).name, "AbortError");
		return true;
	});
	await assertPortReleased();
});

test("abort during callback wait, UI failure, and timeout clean up listener", async () => {
	const controller = new AbortController();
	await assert.rejects(loginDevinWithOptions(callbacks(() => controller.abort(SECRET), controller.signal), {
		fetch: idleFetch, timeoutMs: 2000,
	}), error => assertSafe(error, /cancelled/));
	await assertPortReleased();
	await assert.rejects(loginDevinWithOptions(callbacks(() => { throw new Error(SECRET); }), {
		fetch: idleFetch, timeoutMs: 2000,
	}), error => assertSafe(error, /authorization page/));
	await assertPortReleased();
	await assert.rejects(loginDevinWithOptions(callbacks(() => {}), {
		fetch: idleFetch, timeoutMs: 25,
	}), /timed out/);
	await assertPortReleased();
});

test("abort while binding cleans up even if no browser callback runs", async () => {
	const controller = new AbortController();
	const pending = loginDevinWithOptions(callbacks(() => {}, controller.signal), {
		fetch: idleFetch, timeoutMs: 2000,
	});
	controller.abort(SECRET);
	await assert.rejects(pending, error => assertSafe(error, /cancelled/));
	await assertPortReleased();
});

test("abort and deadline propagate to token fetch and bound even an uncooperative fetch", async () => {
	for (const mode of ["abort", "timeout"]) {
		const controller = new AbortController();
		let fetchSignal: AbortSignal | undefined;
		const pending = loginDevinWithOptions(callbacks(async info => {
			await localRequest(callbackUrl(info.url));
		}, controller.signal), {
			fetch: async (_input, init) => {
				fetchSignal = init?.signal ?? undefined;
				if (mode === "abort") controller.abort(SECRET);
				return new Promise<Response>(() => {});
			},
			timeoutMs: mode === "timeout" ? 100 : 2000,
		});
		await assert.rejects(pending, error => assertSafe(error, mode === "abort" ? /cancelled/ : /timed out/));
		assert.equal(fetchSignal?.aborted, true);
		await assertPortReleased();
	}
});

test("refresh does not make network calls or ever extend expiry; expired credentials require login", async () => {
	const original: OAuthCredentials = { access: "opaque", refresh: "opaque", expires: Date.now() + 100_000, extra: true };
	const saved = { ...original };
	const signal = new AbortController().signal;
	assert.equal(await refreshDevin(original, signal), original);
	assert.equal(await refreshDevin(original, signal), original);
	assert.deepEqual(original, saved);
	for (const invalid of [
		{ ...original, expires: Date.now() },
		{ ...original, expires: 0 },
		{ ...original, expires: NaN },
		{ ...original, expires: Infinity },
		{ ...original, access: "" },
		{ ...original, access: jwt({ exp: Date.now() / 1000 - 1 }) },
	]) {
		await assert.rejects(refreshDevin(invalid, signal), /login devin.*does not support token refresh/);
	}
	const controller = new AbortController(); controller.abort(SECRET);
	await assert.rejects(refreshDevin(original, controller.signal), error => assertSafe(error, /cancelled/));
	assert.deepEqual(original, saved);
});
