/**
 * `doctor` — every check runs WITHOUT touching inference quota.
 *
 * Checks: Loomy session file → upstream identity probe → shim assembly
 * (healthz + bearer guard) → credits → model catalog. `--json` for machines;
 * exit codes 0 all-ok / 1 some-failed / 2 crash. Never prints the session.
 *
 * @module dsh-connect-loomy/cli-doctor
 */

import { createLoomyShim } from "./loomy-shim.js";
import { chatModelsOf, FALLBACK_LOOMY_MODELS } from "./loomy-catalog.js";
import { LoomyError, readLoomySession } from "./loomy-credentials.js";
import { createLoomyDiscovery } from "./loomy-discovery.js";
import { configRootCandidates } from "./loomy-paths.js";
import { LoomyUpstream } from "./loomy-upstream.js";

/** @typedef {{name: string, status: "ok"|"fail"|"skip", detail: string, data?: object}} Check */

function safeMessage(error) {
	return String(error?.message ?? "unknown error").slice(0, 200);
}

/**
 * Run every doctor check.
 *
 * @param {{ configRoot?: string, baseUrl?: string }} [options]
 * @returns {Promise<{ ok: boolean, checks: Check[] }>}
 */
export async function runDoctor(options = {}) {
	/** @type {Check[]} */
	const checks = [];
	const upstream = new LoomyUpstream({
		configRoot: () => options.configRoot ?? "",
		baseUrl: () => options.baseUrl ?? "",
		timeoutMs: 20_000,
	});

	// 1. Session file — the local login state this plugin reuses.
	const session = readLoomySession(options.configRoot ?? "");
	if (session) {
		checks.push({
			name: "credentials",
			status: "ok",
			detail: `已读取 Loomy 登录态（${session.path}）`,
			data: { userid: `${session.userid.slice(0, 6)}…`, sessionPath: session.path },
		});
	} else {
		const candidates = configRootCandidates(options.configRoot ?? "");
		checks.push({
			name: "credentials",
			status: candidates.length > 0 ? "fail" : "skip",
			detail: candidates.length > 0
				? `未找到已登录的 auth-session.json（检查过：${candidates.join("；")}）。请先在 Loomy 桌面端登录。`
				: "本机未找到 Loomy 配置根目录（且未配置 configRoot 覆盖）。",
			data: { candidates },
		});
	}

	// 2. Upstream identity — cheapest authenticated call, proves the session.
	if (session) {
		try {
			await upstream.probeIdentity();
			checks.push({ name: "account", status: "ok", detail: "上游身份校验通过（未消耗推理额度）" });
		} catch (error) {
			const kind = error instanceof LoomyError ? error.kind : "upstream";
			checks.push({ name: "account", status: "fail", detail: safeMessage(error), data: { kind } });
		}
	} else {
		checks.push({ name: "account", status: "skip", detail: "未登录，跳过" });
	}

	// 3. Shim assembly — bind, healthz, and the bearer guard must reject.
	try {
		const shim = createLoomyShim({
			upstream,
			modelsProvider: () => chatModelsOf(FALLBACK_LOOMY_MODELS),
		});
		await shim.ready;
		const origin = shim.baseUrl();
		const healthz = await fetch(`${origin}/healthz`, {
			headers: { Authorization: `Bearer ${shim.token()}` },
			signal: AbortSignal.timeout(5_000),
		});
		const healthzBody = await healthz.json().catch(() => ({}));
		let guardOk = false;
		try {
			const unauthed = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5_000) });
			guardOk = unauthed.status === 401;
		} catch {
			guardOk = false;
		}
		const ok = healthz.status === 200 && healthzBody?.ok === true && guardOk;
		checks.push({
			name: "provider",
			status: ok ? "ok" : "fail",
			detail: ok
				? `loopback shim 已就绪（${origin}），鉴权守卫生效`
				: `shim 自检失败（healthz=${healthz.status}, bearer-guard=${guardOk ? "ok" : "fail"}）`,
			data: { origin, healthz: healthz.status, bearerGuard: guardOk },
		});
		shim.close();
	} catch (error) {
		checks.push({ name: "provider", status: "fail", detail: safeMessage(error) });
	}

	// 4. Credits — read-only gateway call.
	if (session) {
		try {
			const credits = await upstream.fetchCredits({ pageSize: 5 });
			checks.push({
				name: "quota",
				status: "ok",
				detail: `额度读取成功（可用 ${credits.availableBalance} = ${credits.balance} + 每日 ${credits.dailyBalance}）`,
				data: { balance: credits.balance, dailyBalance: credits.dailyBalance, availableBalance: credits.availableBalance },
			});
		} catch (error) {
			const kind = error instanceof LoomyError ? error.kind : "upstream";
			checks.push({ name: "quota", status: kind === "network" ? "fail" : "fail", detail: safeMessage(error), data: { kind } });
		}
	} else {
		checks.push({ name: "quota", status: "skip", detail: "未登录，跳过" });
	}

	// 5. Catalog — the gateway rows that will feed the DSH picker.
	try {
		const discovery = createLoomyDiscovery(upstream);
		const source = await discovery.refresh();
		const rows = discovery.current();
		const ok = rows.length > 0;
		checks.push({
			name: "models",
			status: ok ? "ok" : "fail",
			detail: ok
				? `模型目录就绪（来源 ${source}，${rows.length} 个对话模型）：${rows.map((row) => row.id).join(", ")}`
				: "模型目录为空",
			data: { source, count: rows.length, ids: rows.map((row) => row.id) },
		});
	} catch (error) {
		checks.push({ name: "models", status: "fail", detail: safeMessage(error) });
	}

	return { ok: checks.every((check) => check.status !== "fail"), checks };
}

/** CLI entry. */
export async function main(argv = process.argv.slice(2)) {
	const jsonOut = argv.includes("--json");
	const configRootFlag = argv.includes("--config-root") ? argv[argv.indexOf("--config-root") + 1] : undefined;
	const baseUrlFlag = argv.includes("--base-url") ? argv[argv.indexOf("--base-url") + 1] : undefined;

	try {
		const result = await runDoctor({
			configRoot: configRootFlag === undefined ? undefined : String(configRootFlag),
			baseUrl: baseUrlFlag === undefined ? undefined : String(baseUrlFlag),
		});
		if (jsonOut) {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			console.log("dsh-connect-loomy doctor");
			for (const check of result.checks) {
				const mark = check.status === "ok" ? "✓" : check.status === "fail" ? "✗" : "–";
				console.log(` ${mark} ${check.name}: ${check.status} — ${check.detail}`);
			}
			console.log(result.ok ? "\n全部检查通过。" : "\n存在未通过的检查。");
		}
		process.exitCode = result.ok ? 0 : 1;
	} catch (error) {
		if (jsonOut) process.stdout.write(`${JSON.stringify({ ok: false, crash: safeMessage(error) }, null, 2)}\n`);
		else console.error("doctor crashed:", safeMessage(error));
		process.exitCode = 2;
	}
}

// Self-detect direct execution (bin alias imports main() itself).
if (/cli-doctor\.(js|ts|mjs)$/.test(String(process.argv[1] ?? ""))) {
	await main();
}
