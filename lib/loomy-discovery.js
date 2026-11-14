/**
 * Catalog discovery and caching.
 *
 * Discovery is what keeps the DSH picker honest across Loomy releases: the
 * gateway's `/api/v1/models` is fetched on plugin start and on refresh, cached
 * to the plugin's own file, and served from cache (then the embedded fallback)
 * when the gateway is unreachable. A failed refresh NEVER empties the picker
 * and never clears the user's enabled-ids selection.
 *
 * @module dsh-connect-loomy/discovery
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { chatModelsOf, FALLBACK_LOOMY_MODELS } from "./loomy-catalog.js";

const DISCOVERY_TTL_MS = 10 * 60_000;

/** The cache file, next to the sibling plugins' own state files. */
export function catalogCachePath() {
	return join(homedir(), ".dsh", "dsh-connect-loomy.catalog.json");
}

function readCachedRows(path = catalogCachePath()) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (Array.isArray(parsed?.models) && typeof parsed?.fetchedAt === "number") {
			return { models: parsed.models, fetchedAt: parsed.fetchedAt };
		}
	} catch {
		// no cache / corrupt cache — fall through
	}
	return undefined;
}

/** Persist fetched rows atomically (write-temp-then-rename). */
function writeCachedRows(rows, path = catalogCachePath()) {
	const payload = { fetchedAt: Date.now(), models: rows };
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid.toString()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		renameSync(temp, path);
	} catch (error) {
		try { unlinkSync(temp); } catch {}
		// A cache write failure must never break discovery — it is an optimization.
	}
}

/**
 * Create the discovery service.
 *
 * @param {import("./loomy-upstream.js").LoomyUpstream} upstream
 */
export function createLoomyDiscovery(upstream) {
	/** Normalized chat rows currently served. */
	let currentRows = undefined;
	/** Where the current rows came from: "gateway" | "cache" | "fallback". */
	let source = "fallback";
	let lastFetchAt = 0;
	let fetching = undefined;

	/** Seed from cache, then fallback, synchronously — so the picker has rows on first paint. */
	function seed() {
		if (currentRows !== undefined) return;
		const cached = readCachedRows();
		if (cached !== undefined) {
			const rows = chatModelsOf(cached.models);
			if (rows.length > 0) {
				currentRows = rows;
				source = "cache";
				lastFetchAt = cached.fetchedAt;
				return;
			}
		}
		currentRows = chatModelsOf(FALLBACK_LOOMY_MODELS);
		source = "fallback";
	}

	/**
	 * Fetch the gateway catalog and replace the served rows.
	 *
	 * @param {{ force?: boolean }} [options]
	 * @returns {Promise<"gateway" | "cache" | "fallback">} the source actually serving now
	 */
	async function refresh({ force = false } = {}) {
		const now = Date.now();
		if (!force && currentRows !== undefined && source === "gateway" && now - lastFetchAt < DISCOVERY_TTL_MS) {
			return source;
		}
		fetching ??= (async () => {
			try {
				const raw = await upstream.listModels();
				const rows = chatModelsOf(raw);
				if (rows.length > 0) {
					currentRows = rows;
					source = "gateway";
					lastFetchAt = Date.now();
					writeCachedRows(rows);
				}
			} catch {
				// Keep serving whatever we have — cache, then fallback. The card
				// surfaces the failure through the status route instead.
			} finally {
				fetching = undefined;
			}
			return source;
		})();
		return fetching;
	}

	/** The rows served right now (seeding on first touch). */
	function current() {
		seed();
		return currentRows;
	}

	/** Diagnostics for the status route and doctor. */
	function describe() {
		seed();
		return { source, count: currentRows?.length ?? 0, fetchedAt: lastFetchAt || undefined };
	}

	/** Drop the in-memory rows so the next read re-seeds from cache/fallback. */
	function invalidate() {
		currentRows = undefined;
		source = "fallback";
		lastFetchAt = 0;
	}

	return { refresh, current, describe, invalidate };
}
