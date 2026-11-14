/**
 * The loopback shim: the HTTP surface pi-ai talks to.
 *
 * `http://127.0.0.1:<ephemeral>/v1` with a per-process bearer secret. DSH's
 * pi-ai provider sends OpenAI-shaped requests; the shim forwards them to the
 * Loomy gateway with the session-based auth headers and pipes the response
 * straight back — the upstream is OpenAI-compatible natively (tools,
 * reasoning_content deltas, usage chunks, [DONE] all pass through untouched).
 *
 * Hardening follows the sibling plugins:
 * - ephemeral port on 127.0.0.1 only;
 * - a per-process secret compared with timingSafeEqual, length-checked first;
 * - Host header must be loopback, browser Origin must be loopback;
 * - JSON body cap 64 MB (vision requests carry base64 images);
 * - nothing secret ever enters a response body.
 *
 * @module dsh-connect-loomy/shim
 */

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { LoomyError } from "./loomy-credentials.js";

/** Body cap: 64 MB, matching the sibling plugin's vision-friendly bound. */
const BODY_LIMIT = 67_108_864;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Loomy SSE idle watchdog: abort the upstream fetch after this silence. */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

/** Map a LoomyError kind to the HTTP status the shim answers with. */
const STATUS_BY_KIND = {
	not_signed_in: 401,
	session_dead: 401,
	rate_limited: 429,
	network: 502,
	upstream: 502,
	client: 400,
};

function hostnameOfHost(host) {
	let hostname = String(host ?? "").trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}

function hostIsLoopback(host) {
	const hostname = hostnameOfHost(host);
	return hostname !== "" && LOOPBACK_HOSTS.has(hostname);
}

function originIsLoopback(origin) {
	const raw = String(origin ?? "").trim();
	if (raw === "") return true;
	try {
		return LOOPBACK_HOSTS.has(new URL(raw).hostname);
	} catch {
		return false;
	}
}

/** Constant-time bearer check, length pre-checked (timingSafeEqual throws otherwise). */
function bearerMatches(header, secret) {
	const raw = String(header ?? "").trim();
	const prefix = "Bearer ";
	if (!raw.startsWith(prefix)) return false;
	const provided = Buffer.from(raw.slice(prefix.length), "utf8");
	const expected = Buffer.from(secret, "utf8");
	if (provided.length !== expected.length) return false;
	return timingSafeEqual(provided, expected);
}

function writeJson(res, status, body, extraHeaders) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store",
		...(extraHeaders ?? {}),
	});
	res.end(payload);
}

/** The OpenAI error envelope pi-ai's retry layer reads (`type`/`code`/`x-should-retry`). */
function writeOpenAIError(res, status, type, message) {
	const shouldRetry = status === 429 || status >= 500 ? "true" : "false";
	writeJson(res, status, { error: { message, type, code: type } }, { "x-should-retry": shouldRetry });
}

function readBody(req, { limit = BODY_LIMIT } = {}) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/**
 * Create the loopback shim.
 *
 * @param {object} options
 * @param {import("./loomy-upstream.js").LoomyUpstream} options.upstream the upstream client
 * @param {() => object | undefined} options.modelsProvider live normalized model rows
 * @param {(credits: object) => object} [options.creditsView] allow-listed quota view builder
 * @param {() => object} [options.creditsProvider] cached credits snapshot provider
 */
export function createLoomyShim({ upstream, modelsProvider, creditsProvider }) {
	const secret = randomBytes(32).toString("base64url");
	const server = createServer();
	let listening = false;

	const ready = new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	}).then(() => {
		listening = true;
	});

	server.on("request", (req, res) => {
		// Gate order: cheap header checks first, so a rejected request never
		// reaches the filesystem or the upstream.
		if (!hostIsLoopback(req.headers.host)) {
			writeJson(res, 403, { error: "host-not-loopback" });
			return;
		}
		if (!originIsLoopback(req.headers.origin)) {
			writeJson(res, 403, { error: "origin-not-trusted" });
			return;
		}
		if (!bearerMatches(req.headers.authorization, secret)) {
			writeOpenAIError(res, 401, "invalid_api_key", "invalid loopback shim credential");
			return;
		}

		const url = new URL(req.url ?? "/", "http://127.0.0.1");

		if (req.method === "GET" && url.pathname === "/healthz") {
			writeJson(res, 200, { ok: true, provider: "loomy" });
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/models") {
			const rows = modelsProvider();
			if (rows === undefined) {
				// Not discovered yet — let the catalog discovery path retry.
				writeOpenAIError(res, 503, "models_unavailable", "Loomy model catalog is not loaded yet");
				return;
			}
			writeJson(res, 200, {
				object: "list",
				data: rows.map((row) => ({
					id: String(row.id),
					object: "model",
					created: Number(row?.created) || 0,
					owned_by: "loomy",
				})),
			});
			return;
		}

		if (req.method === "GET" && url.pathname === "/quota") {
			const credits = creditsProvider?.();
			if (credits === undefined) {
				writeJson(res, 503, { error: "quota_unavailable" });
				return;
			}
			writeJson(res, 200, credits);
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
			void handleChat(req, res).catch(() => {
				if (!res.headersSent) writeOpenAIError(res, 502, "SERVER", "shim failure");
				else res.end();
			});
			return;
		}

		writeOpenAIError(res, 404, "not_found", `no route for ${req.method} ${url.pathname}`);
	});

	/**
	 * The chat proxy: parse the pi-ai body, forward to the Loomy gateway with
	 * session auth, and pipe the response — SSE or JSON — straight back.
	 */
	async function handleChat(req, res) {
		let body;
		try {
			const raw = await readBody(req);
			if (raw.length === 0) throw Object.assign(new Error("empty body"), { statusCode: 400 });
			body = JSON.parse(raw.toString("utf8"));
		} catch (error) {
			writeOpenAIError(res, error?.statusCode ?? 400, "invalid_request_error", "invalid JSON body");
			return;
		}
		if (typeof body?.model !== "string" || body.model === "") {
			writeOpenAIError(res, 400, "invalid_request_error", "model is required");
			return;
		}

		const wantsStream = body.stream === true;
		const upstreamController = new AbortController();
		/** Re-armable idle watchdog: aborts the upstream after STREAM_IDLE_TIMEOUT_MS silence. */
		let idleTimer = setTimeout(() => upstreamController.abort(new Error("stream idle timeout")), STREAM_IDLE_TIMEOUT_MS);
		const bumpIdle = () => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => upstreamController.abort(new Error("stream idle timeout")), STREAM_IDLE_TIMEOUT_MS);
		};
		const disarmIdle = () => clearTimeout(idleTimer);

		req.on("close", () => {
			if (!res.writableEnded) upstreamController.abort(new Error("client closed"));
		});

		let response;
		try {
			response = await upstream.chatCompletion(body, { signal: upstreamController.signal });
		} catch (error) {
			disarmIdle();
			if (error instanceof LoomyError) {
				const status = STATUS_BY_KIND[error.kind] ?? 502;
				writeOpenAIError(res, status, error.kind.toUpperCase(), error.message);
				return;
			}
			if (error?.name === "AbortError") {
				writeOpenAIError(res, 504, "TIMEOUT", "Loomy upstream timed out");
				return;
			}
			writeOpenAIError(res, 502, "SERVER", String(error?.message ?? "Loomy upstream failure").slice(0, 200));
			return;
		}

		// Pass-through. The upstream already speaks OpenAI: role/content deltas,
		// reasoning_content deltas, tool_calls deltas, a usage chunk, `data: [DONE]`.
		const headers = { "Cache-Control": "no-store", "X-Accel-Buffering": "no" };
		if (wantsStream) {
			res.writeHead(200, {
				...headers,
				"Content-Type": "text/event-stream; charset=utf-8",
				Connection: "keep-alive",
			});
			res.flushHeaders?.();
			try {
				const reader = response.body.getReader();
				const pump = async () => {
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							bumpIdle();
							res.write(Buffer.from(value));
						}
						res.end();
					} catch (error) {
						if (!res.writableEnded) {
							// A mid-stream failure can only be signalled in-band; SSE
							// consumers treat an unannounced close as an error.
							try {
								const message = String(error?.message ?? "upstream stream failure").slice(0, 200);
								res.write(`data: ${JSON.stringify({ error: { message, type: "SERVER", code: "SERVER" } })}\n\n`);
								res.write("data: [DONE]\n\n");
							} catch {}
							res.end();
						}
					} finally {
						disarmIdle();
					}
				};
				await pump();
			} catch {
				disarmIdle();
				if (!res.writableEnded) res.end();
			}
		} else {
			disarmIdle();
			const text = await response.text().catch(() => "");
			res.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8" });
			res.end(text);
		}
	}

	return {
		/** Resolves once the socket is listening; rejects on bind failure. */
		ready,
		/** The per-process bearer secret pi-ai sends as its apiKey. */
		token: () => secret,
		/** Throws until listening; returns the `http://127.0.0.1:<port>` origin. */
		baseUrl() {
			if (!listening) throw new Error("loomy shim is not listening yet");
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			return `http://127.0.0.1:${port}`;
		},
		/** Sync variant for contexts that cannot await. */
		baseUrlSync() {
			const address = server.address();
			return typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : undefined;
		},
		close() {
			server.close();
		},
	};
}
