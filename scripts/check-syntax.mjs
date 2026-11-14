/**
 * `node --check` over every shipped JS file.
 *
 * The plugin ships hand-written ESM (node side) and CJS-shaped browser code
 * (lib/client.js must stay CommonJS-compatible — the desktop shell loads it
 * as a plain script). This gate pins both: every file parses, and the client
 * bundle contains no top-level ESM syntax that would kill the web boot.
 *
 * Part of `npm run typecheck`'s sibling gate and the CI matrix.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../lib", import.meta.url));
const files = readdirSync(root).filter((name) => name.endsWith(".js"));
let failed = 0;
for (const file of files) {
	const path = join(root, file);
	const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
	if (result.status !== 0) {
		failed += 1;
		console.error(`✗ ${file}\n${result.stderr}`);
	} else {
		console.log(`✓ ${file}`);
	}
}
const client = files.find((name) => name === "client.js");
if (client) {
	const text = await import("node:fs").then((fs) => fs.promises.readFile(join(root, client), "utf8"));
	if (/^\s*(import|export)\s/m.test(text)) {
		failed += 1;
		console.error("✗ lib/client.js carries top-level ESM syntax (web boot would die with \"1 entry did not activate\")");
	} else {
		console.log("✓ lib/client.js stays CJS-shaped (window.__ModuleLoader__ wrapper, no top-level import/export)");
	}
}
if (failed > 0) process.exit(1);
console.log(`all ${files.length} files parse`);
