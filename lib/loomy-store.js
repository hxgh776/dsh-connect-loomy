/**
 * The plugin's own settings file.
 *
 * Same story as the sibling plugins: on this host line the plugin's fiber can
 * sit below ACTIVE, which closes the host's settings-mutate path for us —
 * writes would look saved and silently revert. So the writable fields live in
 * a file this plugin owns: synchronous, atomic (write-temp-then-rename), and
 * independent of any host service.
 *
 * Precedence: the file WINS over the config the Loader hands in — the file is
 * the only place a save can land.
 *
 * @module dsh-connect-loomy/store
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { settingsFilePath } from "./loomy-paths.js";

/** Fields the settings card may write, and only these. */
export const WRITABLE_FIELDS = new Set(["enabledModelIds", "configRoot", "baseUrl"]);

/**
 * The persisted subset of a config blob.
 *
 * @param {any} raw an arbitrary parsed JSON blob — only known fields survive
 * @returns {{ enabledModelIds?: string[], configRoot?: string, baseUrl?: string }}
 */
function normalise(raw) {
	const out = {};
	const ids = raw?.enabledModelIds;
	if (Array.isArray(ids)) out.enabledModelIds = ids.filter((entry) => typeof entry === "string");
	const root = raw?.configRoot;
	if (typeof root === "string") out.configRoot = root;
	const base = raw?.baseUrl;
	if (typeof base === "string") out.baseUrl = base;
	return out;
}

/**
 * Read the persisted settings, or `{}` when the file is missing or unusable.
 *
 * @param {string} [path]
 * @returns {{ enabledModelIds?: string[], configRoot?: string, baseUrl?: string }}
 */
export function readStoredSettings(path = settingsFilePath()) {
	try {
		return normalise(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return {};
	}
}

/**
 * Merge persisted settings over the Loader-supplied config.
 *
 * Only recognised keys are carried, so a hand-edited file cannot inject an
 * unknown field into the live config.
 */
export function withStoredSettings(config, path = settingsFilePath()) {
	const stored = readStoredSettings(path);
	return {
		enabledModelIds: stored.enabledModelIds ?? (Array.isArray(config?.enabledModelIds) ? config.enabledModelIds.filter((entry) => typeof entry === "string") : []),
		configRoot: stored.configRoot ?? (typeof config?.configRoot === "string" ? config.configRoot : ""),
		baseUrl: stored.baseUrl ?? (typeof config?.baseUrl === "string" ? config.baseUrl : ""),
	};
}

/**
 * Persist one field, atomically.
 *
 * @param {"enabledModelIds" | "configRoot" | "baseUrl"} field
 * @param {string[] | string} value
 */
export function writeStoredSetting(field, value, path = settingsFilePath()) {
	if (!WRITABLE_FIELDS.has(field)) throw new Error(`field ${field} is not persistable`);
	const next = { ...readStoredSettings(path) };
	if (field === "enabledModelIds") {
		if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
			throw new Error(`invalid value for ${field}`);
		}
		next.enabledModelIds = value.filter((entry) => typeof entry === "string");
	} else {
		if (typeof value !== "string") throw new Error(`invalid value for ${field}`);
		next[field] = value;
	}
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid.toString()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		renameSync(temp, path);
	} catch (error) {
		try { unlinkSync(temp); } catch {}
		throw error;
	}
}
