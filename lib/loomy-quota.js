/**
 * The read-only credits view.
 *
 * Only numbers the Loomy backend publishes about the SIGNED-IN account travel
 * through here — never the session token, never the user id, never a raw
 * upstream field. The card renders exactly this allow-listed shape.
 *
 * Caching: success 5 min, failure 30 s — the sibling convention. A failed
 * refresh must not hammer the gateway from a poll loop.
 *
 * @module dsh-connect-loomy/quota
 */

import { LoomyError } from "./loomy-credentials.js";

const SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;

/** Truncate an upstream message into a route-safe string. */
function safeMessage(error) {
	return String(error?.message ?? "unknown error").slice(0, 200);
}

/**
 * Create the credits service.
 *
 * @param {import("./loomy-upstream.js").LoomyUpstream} upstream
 * @param {() => string} configRoot live settings getter
 */
export function createLoomyCredits(upstream, configRoot) {
	let cache = { at: 0, value: undefined, error: undefined };

	async function refresh({ force = false } = {}) {
		const now = Date.now();
		const ttl = cache.error === undefined ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
		if (!force && cache.value !== undefined && now - cache.at < ttl) return cache.value;

		try {
			const credits = await upstream.fetchCredits({ pageSize: 20 });
			cache = { at: now, value: credits, error: undefined };
		} catch (error) {
			const kind = error instanceof LoomyError ? error.kind : "upstream";
			const snapshot = cache.value;
			// A stale snapshot served with an error marker beats an empty card.
			cache = { at: now, value: snapshot, error: { kind, message: safeMessage(error) } };
		}
		return cache.value;
	}

	/** The cached snapshot synchronously, for the shim's /quota route. */
	function snapshot() {
		return cache.value;
	}

	/** Invalidate so the next read hits the gateway. */
	function invalidate() {
		cache = { at: 0, value: undefined, error: undefined };
	}

	/**
	 * The route-facing view: allow-listed numbers only, plus a compact state.
	 *
	 * The daily allowance follows Loomy's own business-day cycle
	 * (`dailyCycleDate`); the UI shows it as text rather than pretending to
	 * know a reset instant the backend never states.
	 */
	async function view({ force = false } = {}) {
		const credits = await refresh({ force });
		const error = cache.error;
		if (credits === undefined) {
			return {
				ok: false,
				signedIn: error?.kind !== "not_signed_in",
				points: null,
				ledger: [],
				error: error?.message ?? "额度尚未就绪",
				errorKind: error?.kind ?? "upstream",
			};
		}
		return {
			ok: error === undefined,
			signedIn: true,
			points: {
				balance: credits.balance,
				dailyBalance: credits.dailyBalance,
				availableBalance: credits.availableBalance,
				dailyCycleDate: credits.dailyCycleDate ?? null,
			},
			ledger: credits.ledger.map((row) => ({
				description: row.description,
				direction: row.direction,
				points: row.points,
				createdAt: row.createdAt ?? null,
				dailyCycleDate: row.dailyCycleDate ?? null,
			})),
			error: error?.message ?? null,
			errorKind: error?.kind ?? null,
		};
	}

	return { refresh, snapshot, invalidate, view };
}
