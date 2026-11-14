/**
 * The pi-ai provider and its adapter.
 *
 * Peer packages (`@earendil-works/pi-ai`, `@deepseek-ai/dsh-llm`,
 * `@deepseek-ai/dsh-llm-pi-ai`) are resolved from the HOST at runtime and are
 * never bundled — same as the sibling plugins.
 *
 * The one subtlety worth its own module is the pi-ai GENERATION boundary: the
 * host may resolve a 0.85.x (legacy `{systemPrompt, tools, messages}` context)
 * or a 0.86+/1.x (normalized transcript) copy, and a mismatch silently drops
 * the prompt and tools or crashes. The detection and both fold functions are
 * adapted from the trae sibling, which documents the matrix exhaustively; on
 * the healthy path both wrappers are identities and cost one `Array.some`.
 *
 * @module dsh-connect-loomy/adapter
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { LOOMY_PROVIDER, LOOMY_PROVIDER_DISPLAY_NAME, toPiModel } from "./loomy-catalog.js";

/** Idle watchdog handed to the host profile: 5 min, the sibling convention. */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * Image-request bounds. The shim caps the body at 64 MB; the route bounds are
 * the conservative trae-cn set, which the host's image-offload flow uses to
 * shrink oversized requests instead of letting the upstream reject them.
 */
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 1_048_576 * 20,
	requestImagePixelBudget: 1_048_576 * 4,
	requestImageMaxBytes: 1_048_576,
	maxRequestImages: 50,
	imageOffloadCountQuantum: 10,
};

/**
 * Inert pi-ai credentials: this plugin has no pi-ai credential lifecycle —
 * the bearer secret is a per-process shim credential injected by
 * `resolveApiKey`, and the session token lives only in Loomy's own file.
 */
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-connect-loomy has no pi-ai credential lifecycle");
		},
		async delete() {},
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		},
	},
};

// ---------------------------------------------------------------------------
// pi-ai generation detection (adapted from dsh-connect-trae/pi-ai-runtime)
// ---------------------------------------------------------------------------

let cachedRuntimeInfo;

function generationOf(version) {
	if (version === undefined) return undefined;
	const match = /^(\d+)\.(\d+)\./u.exec(String(version));
	if (match === null) return undefined;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (major > 0) return "modern";
	return minor >= 86 ? "modern" : "legacy";
}

function piAiRuntimeInfo() {
	cachedRuntimeInfo ??= (() => {
		try {
			const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
			let root = dirname(entry);
			// Walk up to the package root (the file that exports "." resolved).
			for (let i = 0; i < 6 && root !== dirname(root); i += 1) {
				if (existsSync(join(root, "package.json"))) break;
				root = dirname(root);
			}
			let version;
			try {
				version = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.version;
			} catch {}
			const transcriptPresent = existsSync(join(root, "dist", "utils", "transcript.js"));
			const byVersion = generationOf(version);
			const generation = byVersion !== undefined
				? byVersion
				: transcriptPresent === true
					? "modern"
					: transcriptPresent === false
						? "legacy"
						: "modern";
			return { generation, version, resolvedFrom: root };
		} catch {
			return { generation: "modern", version: undefined, resolvedFrom: undefined };
		}
	})();
	return cachedRuntimeInfo;
}

function isSystemMessage(message) {
	return typeof message === "object" && message !== null && message.role === "system";
}

function contentTextOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
	}
	return texts.join("\n\n");
}

function systemTextOf(message) {
	const parts = [contentTextOf(message.content)];
	const sections = message.sections;
	if (typeof sections === "object" && sections !== null && !Array.isArray(sections)) {
		for (const text of Object.values(sections)) {
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

function replayToolState(message, state) {
	const removed = message.toolsRemoved;
	if (Array.isArray(removed)) {
		for (const tool of removed) {
			if (typeof tool?.name === "string") state.delete(tool.name);
		}
	}
	const added = message.toolsAdded;
	if (Array.isArray(added)) {
		for (const tool of added) {
			if (typeof tool?.name === "string") state.set(tool.name, tool);
		}
	}
}

/** Fold a normalized transcript into the legacy `{systemPrompt, tools, messages}` shape. */
function adaptLegacyPiAiContext(context) {
	if (context === null || typeof context !== "object") return context;
	const messages = Array.isArray(context.messages) ? context.messages : undefined;
	if (messages === undefined) return context;
	if (!messages.some(isSystemMessage)) return context;
	const systemTexts = [];
	const rest = [];
	const toolState = new Map();
	for (const message of messages) {
		if (!isSystemMessage(message)) {
			rest.push(message);
			continue;
		}
		const text = systemTextOf(message);
		if (text !== "") systemTexts.push(text);
		replayToolState(message, toolState);
	}
	const texts = [
		...(context.systemPrompt === undefined || context.systemPrompt === "" ? [] : [context.systemPrompt]),
		...systemTexts,
	];
	const systemPrompt = texts.length > 0 ? texts.join("\n\n") : undefined;
	const promoted = Array.isArray(context.tools) ? undefined : [...toolState.values()];
	return {
		...context,
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		...(promoted === undefined || promoted.length === 0 ? {} : { tools: promoted }),
		messages: rest,
	};
}

/** Lift the legacy shape into the normalized transcript a modern api consumes. */
function adaptModernPiAiContext(context) {
	if (context === null || typeof context !== "object") return context;
	const messages = Array.isArray(context.messages) ? context.messages : undefined;
	if (messages === undefined) return context;
	const prompt = context.systemPrompt;
	const tools = Array.isArray(context.tools) && context.tools.length > 0 ? context.tools : undefined;
	if (!(typeof prompt === "string" && prompt.length > 0) && tools === undefined) return context;
	const head = {
		role: "system",
		content: prompt ?? "",
		...(tools === undefined ? {} : { toolsAdded: tools }),
	};
	const { systemPrompt: _lifted, tools: _liftedTools, ...rest } = context;
	return { ...rest, messages: [head, ...messages] };
}

/** Wrap both stream entry points so the api receives its own generation's context shape. */
function withContextAdaptation(api, generation) {
	const adapt = generation === "modern" ? adaptModernPiAiContext : adaptLegacyPiAiContext;
	const forApi = (context) => adapt(context);
	return {
		...api,
		stream: (model, context, options) => api.stream(model, forApi(context), options),
		streamSimple: (model, context, options) => api.streamSimple(model, forApi(context), options),
	};
}

// ---------------------------------------------------------------------------
// provider + adapter assembly
// ---------------------------------------------------------------------------

/**
 * Build the pi-ai provider and the DSH adapter.
 *
 * @param {object} options
 * @param {() => string} options.baseUrl live shim origin getter
 * @param {() => Array<object>} options.modelsProvider live normalized catalog rows
 * @param {() => string} options.resolveToken shim bearer secret getter
 * @param {string} [options.providerId]
 * @param {string} [options.displayName]
 */
export function createLoomyAdapter({ baseUrl, modelsProvider, resolveToken, providerId = LOOMY_PROVIDER, displayName = LOOMY_PROVIDER_DISPLAY_NAME }) {
	const generation = piAiRuntimeInfo().generation;
	// The host's pi-ai type surface varies across harness lines (see
	// types/peers.d.ts); the descriptors are built to the RUNTIME contract the
	// sibling plugins verified, so this boundary is intentionally `any`.
	const buildModels = () => /** @type {any[]} */ (modelsProvider().map((row) => toPiModel(row, baseUrl(), providerId)));

	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: {
				apiKey: {
					name: "Loomy loopback shim secret",
					async resolve({ credential }) {
						const apiKey = credential?.key;
						return apiKey === undefined || apiKey.length === 0
							? undefined
							: { auth: { apiKey }, source: "Loomy loopback shim" };
					},
				},
			},
			models: buildModels(),
			api: withContextAdaptation(openAICompletionsApi(), generation),
		}),
		getModels: () => buildModels(),
	};
	const piProvider = /** @type {any} */ (provider);

	const profile = {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(undefined, "dsh-connect-loomy retryPolicy"),
		configuredMaxTokens: new Map(),
		modelErrors: new Map(),
		defaultContextWindow: 200_000,
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider,
	};

	const adapter = new PiAiAdapter(/** @type {any} */ ({
		profiles: () => new Map([[providerId, /** @type {any} */ (profile)]]),
		auth: /** @type {any} */ (INERT_AUTH),
		resolveApiKey: async () => resolveToken(),
	}));

	return { adapter, provider: piProvider, profile, generation };
}
