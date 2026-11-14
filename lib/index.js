/**
 * DSH Connect Loomy — plugin entrypoint.
 *
 * Connects the locally signed-in Loomy (iFlytek) account to DeepSeek Harness:
 *
 *   createLoomyShim()        loopback HTTP surface (random port + per-process secret)
 *   createLoomyAdapter()     pi-ai provider registered into ctx.llm
 *   createLoomyCredits()     read-only credits snapshot for the settings card
 *   registerLoomyRoutes()    read-only web routes (quota / catalog / status / save)
 *
 * The upstream is OpenAI-compatible natively (verified against a live signed-in
 * 0.9.39 client): tools, reasoning_content deltas and usage chunks pass through
 * the shim untouched, so DSH's local tool execution sees standard `tool_calls`.
 *
 * This plugin reads Loomy's own auth-session file — it never copies, seals or
 * writes credentials, and it shares nothing with other plugins (no accounts,
 * no credentials, no directories, no toggles).
 *
 * @module dsh-connect-loomy
 */

import z from "@deepseek-ai/schemastery";
import {
	FALLBACK_LOOMY_MODELS,
	LOOMY_PROVIDER,
	LOOMY_PROVIDER_DISPLAY_NAME,
	catalogEntriesOf,
	chatModelsOf,
	enabledModelsOf,
	toPiModel,
} from "./loomy-catalog.js";
import { LoomyError, hasLoomySession, invalidateCredentialCache, readLoomySession } from "./loomy-credentials.js";
import { createLoomyDiscovery } from "./loomy-discovery.js";
import { createLoomyAdapter } from "./loomy-adapter.js";
import { createLoomyCredits } from "./loomy-quota.js";
import { LOOMY_CATALOG_PATH, LOOMY_QUOTA_PATH, LOOMY_SAVE_PATH, LOOMY_STATUS_PATH, registerLoomyRoutes } from "./loomy-routes.js";
import { AUTH_SESSION_FILENAME, authSessionPathIn, configRootCandidates, defaultConfigRoot, settingsFilePath, userHashOf } from "./loomy-paths.js";
import { createLoomyShim } from "./loomy-shim.js";
import { DEFAULT_BASE_URL, LoomyUpstream, buildLoomyHeaders, generateTraceparent } from "./loomy-upstream.js";
import { WRITABLE_FIELDS, readStoredSettings, withStoredSettings, writeStoredSetting } from "./loomy-store.js";

export {
	LOOMY_PROVIDER,
	LOOMY_PROVIDER_DISPLAY_NAME,
	FALLBACK_LOOMY_MODELS,
	chatModelsOf,
	enabledModelsOf,
	toPiModel,
	catalogEntriesOf,
} from "./loomy-catalog.js";
export {
	LoomyError,
	hasLoomySession,
	invalidateCredentialCache,
	readLoomySession,
} from "./loomy-credentials.js";
export {
	LOOMY_QUOTA_PATH,
	LOOMY_CATALOG_PATH,
	LOOMY_STATUS_PATH,
	LOOMY_SAVE_PATH,
	registerLoomyRoutes,
} from "./loomy-routes.js";
export { LoomyUpstream, buildLoomyHeaders, generateTraceparent, DEFAULT_BASE_URL } from "./loomy-upstream.js";
export { createLoomyShim } from "./loomy-shim.js";
export { createLoomyAdapter } from "./loomy-adapter.js";
export { createLoomyCredits } from "./loomy-quota.js";
export { createLoomyDiscovery } from "./loomy-discovery.js";
export { WRITABLE_FIELDS, readStoredSettings, withStoredSettings, writeStoredSetting } from "./loomy-store.js";
export { AUTH_SESSION_FILENAME, authSessionPathIn, configRootCandidates, defaultConfigRoot, userHashOf, settingsFilePath } from "./loomy-paths.js";

const PLUGIN_ID = "dsh-connect-loomy";
const PLUGIN_NAME = "DSH Connect Loomy";
const LOOMY_VERSION = "0.1.0";

/**
 * Diagnostic trail for the settings-presentation registration (sibling
 * convention: several separate ways to silently not appear, so record each).
 */
const presentationDiag = {};

/**
 * The plugin's Cordis name — the Loader and the Settings service key on it.
 * It must be the ENTRY ID, not a display title.
 */
const name = PLUGIN_ID;

/**
 * Services required before the provider may register.
 *
 * `inject: ["llm"]` is REQUIRED — touching `ctx.llm` without the declaration
 * throws and takes the whole plugin down silently. `webServer` and `settings`
 * mount later (or never), so they are NESTED injects inside `apply`.
 */
const inject = ["llm"];

/** The namespace the HOST actually serves this plugin's config under. */
function settingsNamespaceOf(ctx) {
	return ctx.fiber?.entry?.options?.id ?? PLUGIN_ID;
}

/**
 * The DEFAULT a schemastery field validates to, synchronously.
 *
 * This host's schemastery fork exposes the Standard Schema interface and its
 * `~standard.validate` answers synchronously for these simple fields; anything
 * async (or throwing) reads as "unknown" and the caller falls back safely.
 */
function defaultOfSchema(schema) {
	try {
		const validate = schema?.["~standard"]?.validate;
		if (typeof validate !== "function") return undefined;
		const probe = validate(undefined);
		if (probe && typeof probe.then === "function") return undefined;
		return probe?.value;
	} catch {
		return undefined;
	}
}

/**
 * Mark one schema field volatile — this is what makes it writable from a
 * settings form at all.
 *
 * DEFENDED, because the desktop host's schemastery (3.19.0, measured in the
 * app.asar) corrupts EVERY field through `volatile()`: a marked field
 * validates to `{}` no matter what the input or default was — array fields
 * come back as `{}` instead of `[]`. Verified against the live copy:
 * `z.array(z.string()).default([]).volatile()` then `validate({})` →
 * `{"ids":{}}`. The marker is only worth adopting when it round-trips, so the
 * marked schema is probed against the unmarked one's default and the
 * UNMARKED schema (still fully valid for the Loader) wins on any mismatch.
 */
function asVolatile(schema) {
	const candidate = schema;
	if (typeof candidate?.volatile !== "function") return schema;
	let marked;
	try {
		marked = candidate.volatile();
	} catch {
		return schema;
	}
	if (typeof marked !== "function") return schema;
	const unmarkedDefault = defaultOfSchema(candidate);
	const markedDefault = defaultOfSchema(marked);
	if (unmarkedDefault === undefined || markedDefault === undefined) {
		// Cannot prove the marker is safe — keep the honest schema.
		return schema;
	}
	return JSON.stringify(unmarkedDefault) === JSON.stringify(markedDefault) ? marked : schema;
}

/**
 * The settings SCHEMA the Loader reads.
 *
 * It MUST be a real schemastery schema: Cordis calls `.validate()` on it while
 * resolving the entry's config, and a plain object literal fails activation.
 */
const Config = z.object({
	enabledModelIds: asVolatile(z.array(z.string()).default([])).description("在 DSH 模型选择器中启用的 Loomy 模型 id 列表。留空表示未配置，展示全部模型。"),
	configRoot: asVolatile(z.string().default("")).description("Loomy 配置根目录（其 userData/auth-session.json 为登录态文件）。留空自动探测 C:\\Users\\Public\\Loomy\\<用户哈希>。仅当 Loomy 数据被放在非默认位置时需要填写。"),
	baseUrl: asVolatile(z.string().default("")).description("Loomy 积分网关地址覆盖。留空使用内置生产地址 https://loomyad.xunfei.cn。"),
});

/**
 * The ticked ids, or `undefined` when the field is ABSENT/empty — the
 * "not yet configured → serve the whole catalog" state.
 */
function effectiveIds(config) {
	const ids = config?.enabledModelIds;
	if (!Array.isArray(ids) || ids.length === 0) return undefined;
	return ids.filter((entry) => typeof entry === "string");
}

/**
 * Read the session state for the status route / doctor, without leaking
 * secrets — only a truncated userid and the resolved file path.
 */
function sessionStateOf(configRoot = "") {
	const candidates = configRootCandidates(configRoot);
	const session = readLoomySession(configRoot);
	return {
		signedIn: session !== undefined,
		userid: session?.userid ? `${session.userid.slice(0, 6)}…` : null,
		sessionPath: session?.path ?? null,
		candidates: candidates.map((root) => ({
			root,
			found: Boolean(readLoomySession(root)?.path),
		})),
	};
}

/**
 * Wire the provider and the read-only routes.
 *
 * Every disposer hangs off one `ctx.effect`, so unloading the plugin releases
 * the shim's port, the adapter, the directory entry, the discovery callback
 * and the HTTP routes — nothing outlives the plugin.
 */
function apply(ctx, config = { enabledModelIds: [], configRoot: "", baseUrl: "" }) {
	let shim;
	let adapterRelease;
	let directoryRelease;
	let discoveryRelease;
	let disposed = false;
	const settingsNs = settingsNamespaceOf(ctx);

	/** Live config: the plugin's own file wins over the Loader value. */
	let current = withStoredSettings(config);
	/** A settings change to the config root must drop the cached session read. */
	const applyConfigChange = (previous) => {
		if (String(current?.configRoot ?? "") !== String(previous?.configRoot ?? "")) invalidateCredentialCache();
	};

	const upstream = new LoomyUpstream({
		configRoot: () => current.configRoot,
		baseUrl: () => current.baseUrl,
	});
	const discovery = createLoomyDiscovery(upstream);
	const credits = createLoomyCredits(upstream, () => current.configRoot);

	try {
		shim = createLoomyShim({
			upstream,
			modelsProvider: () => {
				try {
					return enabledModelsOf(discovery.current(), effectiveIds(current));
				} catch {
					return undefined;
				}
			},
			creditsProvider: () => credits.snapshot(),
		});

		// The adapter is built synchronously, like the siblings do: model rows
		// read the shim origin LAZILY (it is undefined until the socket is
		// listening), and the ready callback invalidates + replaces so the host
		// rebuilds the descriptors with the real `http://127.0.0.1:<port>/v1`.
		const { adapter, invalidate } = createLoomyAdapter({
			baseUrl: () => shim.baseUrlSync(),
			modelsProvider: () => enabledModelsOf(discovery.current(), effectiveIds(current)),
			resolveToken: () => shim.token(),
		});
		let invalidateAdapter = invalidate;
		const notifyAdapters = () => {
			if (disposed) return;
			invalidateAdapter?.();
			try {
				adapterRelease?.replace?.([LOOMY_PROVIDER]);
			} catch {}
		};

		adapterRelease = ctx.llm.registerAdapter([LOOMY_PROVIDER], adapter);
		directoryRelease = ctx.llm.registerConfigurableProviders([{
			provider: LOOMY_PROVIDER,
			displayName: LOOMY_PROVIDER_DISPLAY_NAME,
			settingsNs,
			settingsPath: [],
			declared: false,
		}]);

		ctx.effect(() => () => {
			disposed = true;
			adapterRelease?.();
			directoryRelease?.();
			discoveryRelease?.();
			shim?.close();
			shim = undefined;
		});

		try {
			discoveryRelease = ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
				if (request.provider !== undefined && request.provider !== LOOMY_PROVIDER) return [];
				await discovery.refresh().catch(() => {});
				const rows = enabledModelsOf(discovery.current(), effectiveIds(current));
				return rows.map((row) => {
					const caps = row?.capabilities ?? {};
					const input = Array.isArray(caps.input_modalities) && caps.input_modalities.some((m) => m === "image" || m === "video")
						? ["text", "image"]
						: ["text"];
					const maxTokens = Number(row?.max_output_tokens);
					return {
						id: String(row.id),
						name: String(row?.name ?? row.id),
						contextWindow: Number(row.context_length),
						...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
						inputModalities: input,
					};
				});
			});
		} catch (error) {
			ctx.logger?.error?.("dsh-connect-loomy: model discovery registration failed", error);
		}

		// Warm the catalog and re-arm the adapter once the shim is listening.
		shim.ready.then(() => {
			if (disposed) return;
			notifyAdapters();
			discovery.refresh({ force: true }).then(() => {
				notifyAdapters();
				try {
					ctx.emit?.("llm/models-updated", LOOMY_PROVIDER);
				} catch {}
			}).catch(() => {});
		}).catch((error) => {
			ctx.logger?.error?.("dsh-connect-loomy: shim failed to start", error);
		});

		// Settings presentation, via a NESTED `ctx.inject(["settings"], ...)`.
		// The soft probe can run before the settings service exists, which is
		// why the sibling's namespace once never appeared; the inject child is
		// held back until the service is mounted.
		const presentationOwner = ctx.fiber;
		try {
			if (typeof ctx.inject === "function") {
				ctx.inject(["settings"], (settingsCtx) => {
					presentationDiag.injectRan = true;
					const settings = settingsCtx.settings;
					if (settings === undefined || typeof settings.configure !== "function") return;
					const claim = () => {
						presentationDiag.effectRan = true;
						const dispose = settings.configure({ auto: false }, presentationOwner);
						presentationDiag.configureRan = true;
						return dispose;
					};
					if (typeof settingsCtx.effect === "function") settingsCtx.effect.call(settingsCtx, claim);
					else claim();
				});
			}
		} catch (error) {
			presentationDiag.error = error?.message ?? String(error);
			ctx.logger?.error?.("dsh-connect-loomy: settings presentation registration failed", error);
		}

		const onSettingsChanged = (next) => {
			const previous = current;
			if (next !== undefined) current = withStoredSettings(next);
			applyConfigChange(previous);
			notifyAdapters();
		};
		try {
			ctx.on("loader/volatile-update", onSettingsChanged);
		} catch {}

		ctx.inject(["webServer"], (webCtx) => {
			try {
				const disposeRoutes = registerLoomyRoutes(webCtx, {
					quotaView: ({ force } = {}) => credits.view({ force }),
					discovery: () => discovery,
					catalogView: async () => {
						await discovery.refresh().catch(() => {});
						const rows = discovery.current();
						return {
							ok: true,
							source: discovery.describe().source,
							models: catalogEntriesOf(rows),
							enabled: effectiveIds(current) ?? null,
							error: null,
						};
					},
					statusView: () => ({
						ok: true,
						plugin: PLUGIN_ID,
						version: LOOMY_VERSION,
						provider: LOOMY_PROVIDER,
						session: sessionStateOf(current.configRoot),
						catalog: discovery.describe(),
						presentation: { ...presentationDiag },
						baseUrl: upstream.baseUrl(),
					}),
					writableFields: () => WRITABLE_FIELDS,
					writeField: (field, value) => writeStoredSetting(field, value),
					readSettings: () => readStoredSettings(),
					onApplied: (field, value) => {
						const previous = current;
						const next = { ...current };
						if (field === "enabledModelIds" && Array.isArray(value)) {
							next.enabledModelIds = value.filter((id) => typeof id === "string");
						} else if (field === "configRoot" && typeof value === "string") {
							next.configRoot = value;
						} else if (field === "baseUrl" && typeof value === "string") {
							next.baseUrl = value;
						} else {
							return;
						}
						current = next;
						applyConfigChange(previous);
						notifyAdapters();
					},
				});
				ctx.effect(() => () => disposeRoutes());
			} catch (error) {
				ctx.logger?.error?.("dsh-connect-loomy: web route registration failed", error);
			}
		});
	} catch (error) {
		disposed = true;
		ctx.logger?.error?.("dsh-connect-loomy: provider registration failed", error);
		adapterRelease?.();
		directoryRelease?.();
		discoveryRelease?.();
		shim?.close();
		shim = undefined;
	}
}

const src_default = {
	name,
	inject,
	apply,
};

export { Config, PLUGIN_ID, PLUGIN_NAME, LOOMY_VERSION, apply, effectiveIds, inject, name, settingsNamespaceOf, presentationDiag, sessionStateOf };
export default src_default;
