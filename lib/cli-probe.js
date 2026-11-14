/**
 * `probe` — ONE real streaming chat call, exactly what DSH will send.
 *
 * Default model is the gateway's zero-cost row (name carries `(x0.0)`), so a
 * probe usually costs nothing; any other model costs its own multiplier.
 * Flags: `--prompt/-p`, `--model/-m`, `--thinking low|mid|high`, `--tools`,
 * `--json`, `--timeout-ms`. Exit codes: 2 credentials / 3 account / 4 quota /
 * 5 rate-limited / 1 other / 0 ok.
 *
 * @module dsh-connect-loomy/cli-probe
 */

import { createLoomyShim } from "./loomy-shim.js";
import { chatModelsOf, FALLBACK_LOOMY_MODELS } from "./loomy-catalog.js";
import { LoomyError, readLoomySession } from "./loomy-credentials.js";
import { createLoomyCredits } from "./loomy-quota.js";
import { LoomyUpstream } from "./loomy-upstream.js";

const DEFAULT_PROBE_MODEL = "spark-x2.6";
const DEFAULT_PROMPT = "用一句话介绍你自己。";

function safeMessage(error) {
	return String(error?.message ?? "unknown error").slice(0, 200);
}

function flagOf(argv, names, fallback) {
	for (const flag of names) {
		const index = argv.indexOf(flag);
		if (index !== -1 && index + 1 < argv.length) return argv[index + 1];
		// boolean-style `--flag value` pairs handled; bare presence → undefined
	}
	return fallback;
}

/**
 * Run one probe through the full shim path — the same wiring DSH uses.
 *
 * @param {{ prompt?: string, model?: string, thinking?: string, withTools?: boolean, timeoutMs?: number, configRoot?: string, baseUrl?: string, json?: boolean }} [options]
 */
export async function runProbe(options = {}) {
	const timeoutMs = Number(options.timeoutMs) || 60_000;
	const stages = [];
	const record = (name, status, detail, data) => {
		stages.push({ name, status, detail: String(detail).slice(0, 300), ...(data === undefined ? {} : { data }) });
		if (!options.json) console.log(`[${name}] ${status}: ${String(detail).slice(0, 300)}`);
	};

	// Stage 1: credentials.
	const session = readLoomySession(options.configRoot ?? "");
	if (!session) {
		record("credentials", "fail", "未找到本机 Loomy 登录态，请先在 Loomy 桌面端登录");
		return { ok: false, exitCode: 2, stages };
	}
	record("credentials", "ok", `登录态已读取（${session.path}）`, { userid: `${session.userid.slice(0, 6)}…` });

	const upstream = new LoomyUpstream({
		configRoot: () => options.configRoot ?? "",
		baseUrl: () => options.baseUrl ?? "",
		timeoutMs: 20_000,
	});

	// Stage 2: account.
	try {
		await upstream.probeIdentity();
		record("account", "ok", "身份校验通过");
	} catch (error) {
		record("account", "fail", safeMessage(error));
		return { ok: false, exitCode: 3, stages };
	}

	// Stage 3: quota.
	try {
		const credits = createLoomyCredits(upstream, () => options.configRoot ?? "");
		const view = await credits.view({ force: true });
		if (!view.ok && !view.signedIn) {
			record("quota", "fail", "会话已失效");
			return { ok: false, exitCode: 2, stages };
		}
		record("quota", "ok", view.points ? `可用积分 ${view.points.availableBalance}` : "额度读取成功", view.points ?? undefined);
	} catch (error) {
		record("quota", "fail", safeMessage(error));
		return { ok: false, exitCode: 4, stages };
	}

	// Stage 4: one real streaming call through the shim.
	let shim;
	try {
		shim = createLoomyShim({
			upstream,
			modelsProvider: () => chatModelsOf(FALLBACK_LOOMY_MODELS),
		});
		await shim.ready;
		const rows = chatModelsOf(FALLBACK_LOOMY_MODELS);
		const requestedModel = String(options.model ?? DEFAULT_PROBE_MODEL);
		const known = rows.some((row) => row.id === requestedModel);
		const thinking = String(options.thinking ?? "").trim();

		/** @type {object} */
		const body = {
			model: requestedModel,
			stream: true,
			messages: [{ role: "user", content: String(options.prompt ?? DEFAULT_PROMPT) }],
		};
		if (thinking && thinking !== "off") body.reasoning_effort = thinking;
		if (options.withTools === true) {
			body.tools = [{
				type: "function",
				function: {
					name: "get_probe_time",
					description: "返回探针调用的当前时间戳，仅用于验证工具调用通路",
					parameters: { type: "object", properties: {}, required: [] },
				},
			}];
		}

		const startedAt = Date.now();
		const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${shim.token()}` },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			if (response.status === 429) {
				record("chat", "fail", `HTTP 429：${text.slice(0, 200)}`);
				return { ok: false, exitCode: 5, stages };
			}
			record("chat", "fail", `HTTP ${response.status}：${text.slice(0, 200)}`);
			return { ok: false, exitCode: 1, stages };
		}

		// Consume the SSE stream end-to-end, collecting the answer + usage.
		const raw = await response.text();
		const events = raw.split("\n").filter((line) => line.startsWith("data: "));
		let content = "";
		let reasoning = 0;
		let toolCallNames = [];
		let usage = null;
		let finishReason = null;
		for (const line of events) {
			const payload = line.slice("data: ".length).trim();
			if (payload === "[DONE]") break;
			let chunk;
			try { chunk = JSON.parse(payload); } catch { continue; }
			if (chunk?.error) {
				record("chat", "fail", `流内错误：${safeMessage(chunk.error)}`);
				return { ok: false, exitCode: 1, stages };
			}
			if (chunk?.usage) usage = chunk.usage;
			const delta = chunk?.choices?.[0]?.delta;
			if (delta?.content) content += delta.content;
			if (delta?.reasoning_content) reasoning += delta.reasoning_content.length;
			if (Array.isArray(delta?.tool_calls)) {
				for (const call of delta.tool_calls) {
					if (call?.function?.name) toolCallNames.push(call.function.name);
				}
			}
			if (chunk?.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
		}
		const elapsed = Date.now() - startedAt;
		record("chat", "ok", `流式完成（${events.length} 个 chunk，${elapsed} ms，finish=${finishReason ?? "unknown"}）`, {
			model: requestedModel,
			knownModel: known,
			contentLength: content.length,
			reasoningChars: reasoning,
			toolCalls: toolCallNames,
			usage,
			elapsedMs: elapsed,
		});
		if (!options.json && content) console.log(`\n回复片段：${content.slice(0, 300)}${content.length > 300 ? "…" : ""}`);
		return { ok: true, exitCode: 0, stages, content, usage, toolCallNames, finishReason };
	} catch (error) {
		if (error instanceof LoomyError && error.kind === "rate_limited") {
			record("chat", "fail", safeMessage(error));
			return { ok: false, exitCode: 5, stages };
		}
		record("chat", "fail", safeMessage(error));
		return { ok: false, exitCode: 1, stages };
	} finally {
		shim?.close();
	}
}

/** CLI entry. */
export async function main(argv = process.argv.slice(2)) {
	const jsonOut = argv.includes("--json");
	const result = await runProbe({
		prompt: flagOf(argv, ["--prompt", "-p"], DEFAULT_PROMPT),
		model: flagOf(argv, ["--model", "-m"], DEFAULT_PROBE_MODEL),
		thinking: flagOf(argv, ["--thinking"], ""),
		withTools: argv.includes("--tools"),
		timeoutMs: Number(flagOf(argv, ["--timeout-ms"], "0")) || undefined,
		configRoot: flagOf(argv, ["--config-root"], undefined) && String(flagOf(argv, ["--config-root"], "")),
		baseUrl: flagOf(argv, ["--base-url"], undefined) && String(flagOf(argv, ["--base-url"], "")),
		json: jsonOut,
	});
	if (jsonOut) {
		const { content, ...rest } = result;
		process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
	}
	process.exitCode = result.exitCode;
}

// Self-detect direct execution.
if (/cli-probe\.(js|ts|mjs)$/.test(String(process.argv[1] ?? ""))) {
	await main();
}
