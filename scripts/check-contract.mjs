/**
 * Wiring-contract regression gate.
 *
 * Catches the class of bug `doctor`/`probe` cannot see: they hard-code the
 * shim's `/v1` prefix themselves, so both were green while the REAL pi-ai
 * chain 404'd — `apply()` passed the shim's bare origin as `baseUrl`, and
 * pi-ai appends `/chat/completions` verbatim, landing on `/chat/completions`
 * (no `/v1`) where the shim has no route.
 *
 * Drives the real entry module against a mock Cordis context (peer packages
 * come from devDependencies, exactly like CI's `npm install`), then reads the
 * descriptors through the adapter's own profile — the same lazy `getModels()`
 * path the host consumes — and asserts every baseUrl carries the `/v1`
 * suffix. Runs offline: without a Loomy session the catalog falls back to the
 * embedded rows, which is enough to assert the wiring.
 */
const plugin = await import("../lib/index.js");

const assert = (cond, label) => {
	console.log(`${cond ? "✓" : "✗"} ${label}`);
	if (!cond) process.exitCode = 1;
};

assert(plugin.name === "dsh-connect-loomy", "entry id contract");
assert(Array.isArray(plugin.inject) && plugin.inject.includes("llm"), "inject contract");
assert(typeof plugin.Config === "function", "Config is a schemastery schema");

const calls = { adapter: null };
const ctx = {
	fiber: { entry: { options: { id: "dsh-connect-loomy" } } },
	llm: {
		registerAdapter(providers, adapter) {
			calls.adapter = adapter;
			return { replace() {}, dispose() {} };
		},
		registerConfigurableProviders() {
			return () => {};
		},
		registerModelDiscovery() {
			return () => {};
		},
	},
	effect() {
		return () => {};
	},
	inject(services, fn) {
		if (services.includes("settings")) {
			fn({ settings: { configure() {
				return () => {};
			} }, effect() {} });
		}
		if (services.includes("webServer")) {
			fn({ webServer: { register() {
				return () => {};
			} } });
		}
	},
	on() {},
	emit() {},
	get() {
		return undefined;
	},
	logger: { error() {} },
};

plugin.apply(ctx, {});

await new Promise((resolve) => setTimeout(resolve, 1500));

assert(calls.adapter !== null, "registerAdapter received the PiAiAdapter instance");

// THE regression: read the descriptors the host consumes (profile.piProvider
// is the lazy getModels() path) and assert the /v1 suffix survived the wiring.
const profile = calls.adapter.config.profiles().get("loomy");
const models = profile.piProvider.getModels();
assert(models.length > 0, `descriptors built (${models.length} models from fallback catalog)`);
const bad = models.filter((m) => !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(m.baseUrl));
assert(bad.length === 0, `every baseUrl ends with /v1 (${models.length - bad.length}/${models.length})`);
if (bad.length > 0) console.log("offending baseUrls:", bad.map((m) => `${m.id} -> ${m.baseUrl}`).join(", "));

// Unit-level: toPiModel never invents or strips the suffix — the caller owns it.
const { toPiModel } = await import("../lib/index.js");
const row = { id: "unit", name: "unit", type: "chat", context_length: 1000, capabilities: {} };
assert(toPiModel(row, "http://127.0.0.1:1/v1").baseUrl === "http://127.0.0.1:1/v1", "toPiModel preserves /v1 suffix verbatim");
assert(toPiModel(row, "http://127.0.0.1:1").baseUrl === "http://127.0.0.1:1", "toPiModel does not invent /v1 (caller's contract)");

console.log(process.exitCode ? "CONTRACT FAILED" : "CONTRACT OK");

process.exit(process.exitCode ?? 0);
