/**
 * Real-chain acceptance: drive ONE streaming call through pi-ai's OWN URL
 * assembly against the patched wiring (descriptor baseUrl from apply()'s
 * shimBaseUrl), NOT the doctor/probe path (they hard-code /v1 and mask this
 * class of bug). Consumes one free-model call (spark-x2.6, multiplier x0.0).
 * Requires: Loomy desktop signed in on this machine.
 */
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createLoomyShim } from "../lib/loomy-shim.js";
import { LoomyUpstream } from "../lib/loomy-upstream.js";
import { chatModelsOf, FALLBACK_LOOMY_MODELS } from "../lib/loomy-catalog.js";

const upstream = new LoomyUpstream({ configRoot: () => "", baseUrl: () => "" });
const rows = chatModelsOf(FALLBACK_LOOMY_MODELS);
const shim = createLoomyShim({ upstream, modelsProvider: () => rows });
await shim.ready;

// THE PATCHED WIRING: exactly what lib/index.js feeds the descriptors now.
const shimBaseUrl = () => {
	const origin = shim.baseUrlSync();
	return origin === undefined ? undefined : `${origin}/v1`;
};
const model = /** @type {any} */ ({  // host pi-ai types vary; runtime contract is what this probe drives
	id: "spark-x2.6",
	name: "Spark-X2.6",
	api: "openai-completions",
	provider: "loomy",
	baseUrl: shimBaseUrl(),
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 32000,
	reasoning: true,
	compat: { supportsReasoningEffort: true },
});
console.log("descriptor baseUrl:", model.baseUrl);
if (!/\/v1$/.test(model.baseUrl)) {
	console.log("FAIL: baseUrl missing /v1 suffix");
	process.exit(1);
}

const api = openAICompletionsApi();
const context = /** @type {any} */ ({ messages: [{ role: "user", content: "只回复两个字：成功" }] });
const options = { apiKey: shim.token(), maxTokens: 32 };

let text = "";
let streamErr = null;
try {
	for await (const chunk of /** @type {any} */ (await /** @type {any} */ (api.stream(model, context, options)))) {
		// Chunk shapes vary across pi-ai generations (reasoning deltas, text
		// deltas, message snapshots) — read loosely, this is an acceptance
		// probe, not a typed consumer.
		const anyChunk = /** @type {any} */ (chunk);
		if (typeof anyChunk?.delta === "string") text += anyChunk.delta;
		else if (typeof anyChunk?.text === "string") text += anyChunk.text;
		else if (typeof anyChunk?.partial?.content === "string") text = anyChunk.partial.content;
	}
} catch (error) {
	streamErr = error;
}

if (streamErr) {
	console.log("STREAM ERROR:", streamErr?.message?.slice(0, 300));
	shim.close();
	process.exit(1);
}
console.log("streamed reply:", text.slice(0, 80));
shim.close();
const ok = text.length > 0;
console.log(ok ? "REAL CHAIN OK" : "REAL CHAIN FAILED (empty reply)");
process.exit(ok ? 0 : 1);
