/**
 * The Loomy upstream, as the desktop client speaks it.
 *
 * Every endpoint here was verified live against a signed-in 0.9.39 client
 * (see docs/protocol.md for the evidence):
 *
 *   GET  {base}/api/v1/models            full model catalog
 *   POST {base}/api/v1/chat/completions  OpenAI-compatible, SSE or JSON
 *   GET  {base}/api/v1/points/records    credits ledger + balances
 *   GET  {base}/api/v1/user/identity     account identity probe
 *
 * Auth is the desktop session token, sent BOTH ways the client sends it:
 * `Authorization: Bearer <session>` and a plain `token: <session>` header.
 * The gateway also hard-requires a W3C `traceparent` — without one a
 * chat/completions call hangs until timeout (observed on the client's own
 * internal LLM path and documented in its source), so one is always generated.
 *
 * @module dsh-connect-loomy/upstream
 */

import { randomUUID, randomBytes } from "node:crypto";
import { LoomyError, readLoomySession } from "./loomy-credentials.js";

/** Production gateway base, from the client's bundled `.env.prod`. */
export const DEFAULT_BASE_URL = "https://loomyad.xunfei.cn";

/** The version header value the desktop client of this build sends. */
export const LOOMY_VERSION = "0.9.39";

/** Envelope code the Loomy backend returns when the session has expired. */
const AUTH_ERROR_CODES = new Set(["020002", "100002", "100003"]);

/**
 * A fresh W3C traceparent, in the exact shape Loomy's request-headers module
 * validates: `00-<32hex>-<16hex>-01`.
 */
export function generateTraceparent() {
	return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

/** A `chat-<uuid>` conversation id, the shape Loomy's own client sends. */
function generateChatId() {
	return `chat-${randomUUID()}`;
}

/**
 * Build the full request-header set the Loomy gateway expects.
 *
 * @param {object} [options]
 * @param {string} [options.session] session token; required for authed calls
 * @param {string} [options.chatId] conversation id for billing aggregation
 * @param {string} [options.purpose] X-Loomy-Request-Purpose protocol value
 * @param {boolean} [options.stream] whether an SSE response is expected
 */
export function buildLoomyHeaders({ session, chatId, purpose = "chat.message", stream = false } = {}) {
	if (!session || typeof session !== "string") {
		throw new LoomyError("未检测到本机 Loomy 登录态，请先在 Loomy 桌面端登录", "not_signed_in");
	}
	const headers = {
		Accept: stream ? "text/event-stream" : "application/json",
		Authorization: `Bearer ${session}`,
		token: session,
		traceparent: generateTraceparent(),
		"X-Loomy-Request-Purpose": purpose,
		InvokeOrigin: "user",
		"loomy-version": LOOMY_VERSION,
	};
	if (chatId) headers.ChatId = chatId;
	return headers;
}

/**
 * Map an upstream failure to the plugin's error kinds.
 *
 * The Loomy backend wraps business errors in `{code, desc}` envelopes with
 * HTTP 200; session death is code `100002` ("登录已失效"), the same code the
 * desktop client self-heals on. Network-level failures surface as HTTP 401/403.
 */
function classifyFailure(httpStatus, envelopeCode, message) {
	if (httpStatus === 401 || httpStatus === 403 || AUTH_ERROR_CODES.has(String(envelopeCode ?? ""))) {
		return new LoomyError(
			"Loomy 登录态已失效（请在 Loomy 桌面端重新登录后重试）",
			"session_dead",
			{ httpStatus },
		);
	}
	if (httpStatus === 429) {
		return new LoomyError("Loomy 上游限流，请稍后重试", "rate_limited", { httpStatus });
	}
	if (httpStatus >= 500) {
		return new LoomyError(`Loomy 上游服务错误：HTTP ${httpStatus}`, "upstream", { httpStatus });
	}
	if (httpStatus >= 400) {
		return new LoomyError(`Loomy 上游拒绝请求：HTTP ${httpStatus} ${message}`.trim(), "client", { httpStatus });
	}
	return new LoomyError(message || "Loomy 上游调用失败", "upstream", { httpStatus });
}

/** Read a `{code, desc, data}` envelope, mapping failures to LoomyError. */
async function readEnvelope(response) {
	let body;
	try {
		body = await response.json();
	} catch {
		if (!response.ok) throw classifyFailure(response.status, undefined, `HTTP ${response.status}`);
		throw classifyFailure(response.status, undefined, "上游返回了无法解析的响应");
	}
	const code = String(body?.code ?? "");
	if (!response.ok || (code !== "" && code !== "000000")) {
		throw classifyFailure(response.status, code, String(body?.desc ?? body?.message ?? ""));
	}
	return body?.data ?? body;
}

/**
 * One Loomy upstream client. Holds no secrets — the session is read from
 * Loomy's own file through the credentials module on every call.
 */
export class LoomyUpstream {
	/**
	 * @param {object} [options]
	 * @param {() => string} [options.configRoot] live settings getter for the config-root override
	 * @param {() => string} [options.baseUrl] live settings getter for the gateway base override
	 * @param {number} [options.timeoutMs] per-call timeout for non-stream calls
	 */
	constructor({ configRoot = () => "", baseUrl = () => "", timeoutMs = 30_000 } = {}) {
		this.getConfigRoot = configRoot;
		this.getBaseUrl = baseUrl;
		this.timeoutMs = timeoutMs;
	}

	/** The effective gateway base for the current settings. */
	baseUrl() {
		const override = String(this.getBaseUrl?.() ?? "").trim().replace(/\/+$/, "");
		return override !== "" ? override : DEFAULT_BASE_URL;
	}

	/** The session TOKEN for the current settings, or throw `not_signed_in`. */
	requireSession() {
		const session = readLoomySession(this.getConfigRoot?.() ?? "");
		if (!session) {
			throw new LoomyError("未检测到本机 Loomy 登录态，请先在 Loomy 桌面端登录", "not_signed_in");
		}
		return session.session;
	}

	/**
	 * The full model catalog as the gateway publishes it.
	 *
	 * @returns {Promise<Array<object>>} raw model rows (`type`, `protocol`, `capabilities`, …)
	 */
	async listModels() {
		const session = this.requireSession();
		let response;
		try {
			response = await fetch(`${this.baseUrl()}/api/v1/models`, {
				headers: buildLoomyHeaders({ session }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			throw new LoomyError(`无法连接 Loomy 上游：${error?.message ?? error}`, "network", { cause: error });
		}
		const data = await readEnvelope(response);
		// readEnvelope unwraps the `{code, desc, data}` envelope; the models
		// list itself IS that data field.
		if (!Array.isArray(data)) {
			throw new LoomyError("Loomy 模型目录返回了意外的结构", "upstream");
		}
		return data;
	}

	/**
	 * POST one chat completion and hand back the raw Response for streaming.
	 *
	 * The body is the OpenAI chat-completions shape DSH/pi-ai already builds —
	 * the upstream is OpenAI-compatible natively (tools, reasoning_effort,
	 * stream_options.include_usage all verified), so the shim passes it through
	 * after stripping only the client credential headers.
	 *
	 * @param {object} body OpenAI chat-completions request body
	 * @param {{ signal?: AbortSignal }} [options]
	 * @returns {Promise<Response>}
	 */
	async chatCompletion(body, { signal } = {}) {
		const session = this.requireSession();
		const chatId = generateChatId();
		let response;
		try {
			response = await fetch(`${this.baseUrl()}/api/v1/chat/completions`, {
				method: "POST",
				headers: {
					...buildLoomyHeaders({ session, chatId, stream: body?.stream === true }),
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body ?? {}),
				signal,
			});
		} catch (error) {
			if (error?.name === "AbortError") throw error;
			throw new LoomyError(`无法连接 Loomy 上游：${error?.message ?? error}`, "network", { cause: error });
		}
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			let code;
			try { code = JSON.parse(text)?.code; } catch {}
			throw classifyFailure(response.status, code, text.slice(0, 200));
		}
		return response;
	}

	/**
	 * The credits snapshot: balances plus the most recent ledger rows.
	 *
	 * Balances come from the v1 records endpoint, whose envelope carries
	 * `balance` (permanent), `dailyBalance` (per business-day allowance) and
	 * `availableBalance` (their sum) — the exact numbers the Loomy UI shows.
	 *
	 * @param {{ pageSize?: number }} [options]
	 */
	async fetchCredits({ pageSize = 20 } = {}) {
		const session = this.requireSession();
		const query = new URLSearchParams({ pageNo: "1", pageSize: String(Math.min(100, Math.max(1, pageSize))), recordType: "all" });
		let response;
		try {
			response = await fetch(`${this.baseUrl()}/api/v1/points/records?${query}`, {
				headers: buildLoomyHeaders({ session, purpose: "chat.message" }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			throw new LoomyError(`无法连接 Loomy 上游：${error?.message ?? error}`, "network", { cause: error });
		}
		const data = await readEnvelope(response);
		return {
			balance: Number(data?.balance) || 0,
			dailyBalance: Number(data?.dailyBalance) || 0,
			availableBalance: Number(data?.availableBalance) || 0,
			dailyCycleDate: typeof data?.list?.[0]?.dailyCycleDate === "string" ? data.list[0].dailyCycleDate : undefined,
			ledger: Array.isArray(data?.list)
				? data.list.map((row) => ({
					description: String(row?.description ?? ""),
					direction: String(row?.direction ?? ""),
					points: Number(row?.pointsActual) || 0,
					createdAt: Number(row?.createdAt) || undefined,
					dailyCycleDate: typeof row?.dailyCycleDate === "string" ? row.dailyCycleDate : undefined,
				}))
				: [],
		};
	}

	/**
	 * Identity probe — the cheapest authenticated call, used by `doctor` to
	 * verify the session without touching inference quota.
	 */
	async probeIdentity() {
		const session = this.requireSession();
		let response;
		try {
			response = await fetch(`${this.baseUrl()}/api/v1/user/identity`, {
				headers: buildLoomyHeaders({ session }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			throw new LoomyError(`无法连接 Loomy 上游：${error?.message ?? error}`, "network", { cause: error });
		}
		return readEnvelope(response);
	}
}
