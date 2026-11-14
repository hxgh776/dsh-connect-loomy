/**
 * The model catalog: Loomy gateway rows → pi-ai model descriptors.
 *
 * DSH rejects an entire provider on ONE malformed row (`INVALID_MODEL_CONTEXT`
 * — a model without a positive-integer context window takes every other model
 * down with it), so normalization is conservative:
 *
 * - only rows with `type === "chat"` are offered (image models have no place in
 *   a completion picker);
 * - only rows with a positive-integer `context_length` pass — the gateway's
 *   router row (`id: "auto"`) publishes neither a context length nor capability
 *   flags, so it is filtered rather than guessed;
 * - a cached catalog is preferred, and the embedded fallback serves when the
 *   cache is empty AND the gateway is unreachable — an offline start must not
 *   wipe the user's saved selection.
 *
 * @module dsh-connect-loomy/catalog
 */

/** Provider id every registration in this plugin keys on. */
export const LOOMY_PROVIDER = "loomy";

/** Provider display name in DSH's picker. */
export const LOOMY_PROVIDER_DISPLAY_NAME = "Loomy（讯飞）";

/** Fallback context window for rows missing `max_output_tokens`. */
const FALLBACK_MAX_TOKENS = 32_000;

/**
 * The catalog captured live from a signed-in 0.9.39 client on 2026-11-14
 * (`GET /api/v1/models`). Serves when no cached copy exists and the gateway
 * cannot be reached, so a first-run offline install still shows real models.
 * Shape mirrors the wire rows this plugin caches.
 */
export const FALLBACK_LOOMY_MODELS = [
	{
		id: "spark-x2.6",
		name: "Spark-X2.6 正式版(限时免费)(x0.0)",
		object: "model",
		created: 1792460565,
		owned_by: "loomy",
		type: "chat",
		protocol: "openai_chat",
		context_length: 1048576,
		max_output_tokens: 131072,
		capabilities: { reasoning: true, vision: false, function_calling: true, streaming: true, system_message: true, input_modalities: ["text"], output_modalities: ["text"] },
		reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
		default_reasoning_effort: "low",
		is_default_model: true,
		is_default_small_model: true,
	},
	{
		id: "DeepSeek-V4.1-Flash",
		name: "DeepSeek V4.1 Flash(x2.0)",
		object: "model",
		created: 1789379345,
		owned_by: "loomy",
		type: "chat",
		protocol: "openai_chat",
		context_length: 1048576,
		max_output_tokens: 384000,
		capabilities: { reasoning: true, vision: true, function_calling: true, streaming: true, system_message: true, input_modalities: ["text", "image"], output_modalities: ["text"] },
		reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
		default_reasoning_effort: "low",
	},
	{
		id: "deepseek-v4-flash-1017",
		name: "DeepSeek V4.1 Flash 1017(x2.0)",
		object: "model",
		created: 1792487959,
		owned_by: "loomy",
		type: "chat",
		protocol: "openai_chat",
		context_length: 1048576,
		max_output_tokens: 384000,
		capabilities: { reasoning: true, vision: true, function_calling: true, streaming: true, system_message: true, input_modalities: ["text", "image"], output_modalities: ["text"] },
		reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
		default_reasoning_effort: "low",
	},
	{
		id: "GLM-5.3-Flash",
		name: "GLM 5.3 Flash(x0.8)",
		object: "model",
		created: 1787908785,
		owned_by: "loomy",
		type: "chat",
		protocol: "openai_chat",
		context_length: 1048576,
		max_output_tokens: 131072,
		capabilities: { reasoning: true, vision: true, function_calling: true, streaming: true, system_message: true, input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
		reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
		default_reasoning_effort: "low",
	},
	{
		id: "qwen3.8-flash",
		name: "qwen 3.8 flash（x0.8）",
		object: "model",
		created: 1787940747,
		owned_by: "loomy",
		type: "chat",
		protocol: "openai_chat",
		context_length: 1000000,
		max_output_tokens: 131072,
		capabilities: { reasoning: true, vision: true, function_calling: true, streaming: true, system_message: true, input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
		reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
		default_reasoning_effort: "low",
	},
	{
		id: "mimo-v2.5",
		name: "MiMo V2.5（x3.3）",
		object: "model",
		created: 1792552929,
		owned_by: "loomy",
		type: "chat",
		protocol: "openai_chat",
		context_length: 1024000,
		max_output_tokens: 128000,
		capabilities: { reasoning: true, vision: true, function_calling: true, streaming: true, system_message: true, input_modalities: ["text", "image"], output_modalities: ["text"] },
		reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
		default_reasoning_effort: "low",
	},
];

/**
 * Extract the chat models a completion picker may offer from raw gateway rows.
 *
 * @param {Array<object>} rows raw `/api/v1/models` rows
 * @returns {Array<object>} normalized rows, gateway order preserved
 */
export function chatModelsOf(rows) {
	if (!Array.isArray(rows)) return [];
	const seen = new Set();
	const out = [];
	for (const row of rows) {
		const id = String(row?.id ?? "").trim();
		if (id === "" || seen.has(id)) continue;
		if (row?.type !== "chat") continue;
		const contextLength = Number(row?.context_length);
		if (!Number.isInteger(contextLength) || contextLength <= 0) continue;
		seen.add(id);
		out.push(row);
	}
	return out;
}

/**
 * Map the upstream's `reasoning_efforts` list onto the pi-ai thinking-level
 * map.
 *
 * Loomy publishes `none | low | medium | high | xhigh` per model. DSH levels
 * that the model does not advertise stay `null` (offered = never); `off` maps
 * to the upstream's `none` spelling — Loomy DOES have a no-reasoning level, so
 * unlike some upstreams an explicit off is sendable here.
 *
 * @param {Array<string> | undefined} efforts upstream effort ids
 */
function thinkingLevelMapOf(efforts) {
	const has = (level) => (Array.isArray(efforts) && efforts.includes(level) ? level : null);
	return {
		off: has("none"),
		minimal: has("minimal"),
		low: has("low"),
		medium: has("medium"),
		high: has("high"),
		xhigh: has("xhigh"),
		max: has("max"),
	};
}

/**
 * Build one pi-ai model descriptor from a normalized gateway row.
 *
 * `cost` is all zeros on purpose: Loomy bills 积分 (points) by per-model
 * multiplier on the ACCOUNT, not per-token — surface pricing would be a lie.
 * The multiplier stays visible in the model NAME, exactly as the gateway
 * publishes it ("DeepSeek V4.1 Flash(x2.0)").
 *
 * @param {object} row normalized row from {@link chatModelsOf}
 * @param {string} baseUrl the loopback shim's `/v1` origin
 * @param {string} providerId provider id these rows advertise under
 */
export function toPiModel(row, baseUrl, providerId = LOOMY_PROVIDER) {
	const caps = row?.capabilities ?? {};
	const efforts = Array.isArray(row?.reasoning_efforts) ? row.reasoning_efforts : undefined;
	const input = Array.isArray(caps.input_modalities) && caps.input_modalities.some((m) => m === "image" || m === "video")
		? ["text", "image"]
		: ["text"];
	const maxTokens = Number(row?.max_output_tokens);
	return {
		id: String(row.id),
		name: String(row?.name ?? row.id),
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: caps.reasoning === true,
		...(efforts === undefined ? {} : { thinkingLevelMap: thinkingLevelMapOf(efforts) }),
		contextWindow: Number(row.context_length),
		...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : { maxTokens: FALLBACK_MAX_TOKENS }),
		compat: { supportsReasoningEffort: efforts !== undefined },
	};
}

/**
 * The model rows the picker offers, honoring the enabled-ids selection.
 *
 * An ABSENT selection (`undefined`) means "not yet configured" and serves the
 * whole catalog; a present array filters by id and never reorders — gateway
 * order is the display order.
 *
 * @param {Array<object>} rows normalized rows
 * @param {Array<string> | undefined} enabledIds ticked ids, or undefined for all
 */
export function enabledModelsOf(rows, enabledIds) {
	if (!Array.isArray(enabledIds)) return rows;
	const wanted = new Set(enabledIds);
	return rows.filter((row) => wanted.has(String(row.id)));
}

/** The `{id, name}` rows the settings card's checklist renders. */
export function catalogEntriesOf(rows) {
	return rows.map((row) => ({
		id: String(row.id),
		name: String(row?.name ?? row.id),
	}));
}
