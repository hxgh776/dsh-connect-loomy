/**
 * The locally signed-in Loomy session.
 *
 * Loomy writes `{ session, userid, phone, updatedAt }` to
 * `auth-session.json` whenever its own login flow completes and whenever the
 * session rotates. This module reads that file — nothing more:
 *
 * - READ ONLY. No copy is ever written, cached to disk, or sealed away; the
 *   file is re-read on a short TTL so a re-login in Loomy is picked up without
 *   restarting DSH.
 * - The session string never crosses the loopback shim boundary, a web route,
 *   a log line, or an error message. It travels only in the Authorization
 *   header of the HTTPS request to Loomy's own gateway.
 *
 * @module dsh-connect-loomy/credentials
 */

import { readFileSync } from "node:fs";
import { authSessionPathIn, configRootCandidates } from "./loomy-paths.js";

/** How long one read of the session file stays trusted, in milliseconds. */
const READ_TTL_MS = 10_000;

/** The error class every Loomy failure in this plugin carries. */
export class LoomyError extends Error {
	/**
	 * @param {string} message human-readable, safe-to-display
	 * @param {"not_signed_in" | "session_dead" | "network" | "upstream" | "client" | "rate_limited"} kind
	 * @param {{ httpStatus?: number, cause?: unknown }} [meta]
	 */
	constructor(message, kind, meta = {}) {
		super(message);
		this.name = "LoomyError";
		this.kind = kind;
		this.httpStatus = meta.httpStatus;
		this.cause = meta.cause;
	}
}

let cache = { key: "", at: 0, value: undefined };

/**
 * Read the signed-in session, or return `undefined` when nobody is signed in.
 *
 * The cache key is the candidate list itself, so a settings change to
 * `configRoot` invalidates immediately; the TTL re-reads Loomy's file so a
 * fresh login or rotation is seen within a request or two.
 *
 * @param {string} [configRoot] settings override for the Loomy config root
 * @returns {{ session: string, userid: string, phone?: string, updatedAt?: number, path: string } | undefined}
 */
export function readLoomySession(configRoot = "") {
	const candidates = configRootCandidates(configRoot);
	if (candidates.length === 0) return undefined;
	const key = candidates.join("\u0000");
	const now = Date.now();
	if (cache.key === key && now - cache.at < READ_TTL_MS) return cache.value;

	let value;
	for (const root of candidates) {
		const path = authSessionPathIn(root);
		try {
			const raw = JSON.parse(readFileSync(path, "utf8"));
			const session = String(raw?.session ?? "").trim();
			if (session === "") continue;
			value = {
				session,
				userid: String(raw?.userid ?? "").trim(),
				phone: String(raw?.phone ?? "").trim() || undefined,
				updatedAt: Number(raw?.updatedAt) || undefined,
				path,
			};
			break;
		} catch {
			// missing file / corrupt JSON on this root — try the next candidate
		}
	}

	cache = { key, at: now, value };
	return value;
}

/** Drop the cached read so the next call hits the file again. */
export function invalidateCredentialCache() {
	cache = { key: "", at: 0, value: undefined };
}

/** Whether some Loomy install on this machine has a signed-in session. */
export function hasLoomySession(configRoot = "") {
	return readLoomySession(configRoot) !== undefined;
}
