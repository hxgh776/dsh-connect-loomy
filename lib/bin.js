#!/usr/bin/env node
/**
 * `dsh-connect-loomy` — the plugin's CLI alias.
 *
 * Subcommands dispatch to the two diagnostic bins:
 *   doctor [flags]   every check, no quota consumed
 *   probe [flags]    one real streaming call (default model is the free row)
 *
 * @module dsh-connect-loomy/bin
 */

import { main as doctorMain } from "./cli-doctor.js";
import { main as probeMain } from "./cli-probe.js";

const argv = process.argv.slice(2);
const subcommand = String(argv[0] ?? "").toLowerCase();

if (subcommand === "doctor") {
	await doctorMain(argv.slice(1));
} else if (subcommand === "probe") {
	await probeMain(argv.slice(1));
} else {
	console.log("用法：dsh-connect-loomy <doctor|probe> [flags]");
	console.log("  doctor  逐项自检（不消耗推理额度）；flags：--json --config-root <dir> --base-url <url>");
	console.log("  probe   发起一次真实流式对话（默认免费模型）；flags：--prompt/-p --model/-m --thinking <level> --tools --json --timeout-ms <ms> --config-root <dir> --base-url <url>");
	process.exitCode = subcommand === "" ? 0 : 2;
}
