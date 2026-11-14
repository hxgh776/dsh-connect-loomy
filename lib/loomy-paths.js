/**
 * Loomy on-disk locations.
 *
 * Loomy (iFlytek desktop, Electron) keeps its per-user config outside the
 * Windows Roaming profile: `config-path.js` derives a per-user root from
 * `sha256(username)[0:12]` and mounts it at
 *
 *   C:\Users\<public>\Loomy\<hash>\userData\
 *
 * The signed-in session lives in `auth-session.json` there — the file the
 * Loomy main process itself reads and writes. This plugin only ever READS it:
 * the session stays owned by Loomy, refreshes when the user re-logs-in there,
 * and this plugin holds no copy of it anywhere.
 *
 * @module dsh-connect-loomy/paths
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";

/** The file Loomy's own auth-session controller persists to. */
export const AUTH_SESSION_FILENAME = "auth-session.json";

/**
 * The username hash Loomy's `config-path.js` uses for the per-user root:
 * first 12 hex chars of sha256 over the exact `os.userInfo().username`.
 */
export function userHashOf(username = userInfo().username) {
	return createHash("sha256").update(String(username)).digest("hex").slice(0, 12);
}

/**
 * The default Loomy config root for this Windows user, or `undefined` when it
 * does not exist. Only win32 has the `C:\Users\Public\Loomy\<hash>` layout.
 */
export function defaultConfigRoot() {
	if (process.platform !== "win32") return undefined;
	try {
		const root = join("C:", "Users", "Public", "Loomy", userHashOf());
		return existsSync(join(root, "userData", AUTH_SESSION_FILENAME)) ? root : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Every place a Loomy config root may sit, most specific first.
 *
 * 1. the `configRoot` settings field (hand-set in the DSH settings card)
 * 2. the `DSH_LOOMY_CONFIG_ROOT` environment variable (CI / headless probes)
 * 3. the derived default for the current Windows user
 *
 * A candidate that simply does not exist is still returned (first entry): the
 * credentials reader turns "file missing" into the honest `not_signed_in`
 * state rather than silently falling back to some other install's session.
 */
export function configRootCandidates(configRoot = "") {
	const candidates = [];
	const explicit = String(configRoot ?? "").trim();
	if (explicit !== "") candidates.push(explicit);
	const env = String(process.env.DSH_LOOMY_CONFIG_ROOT ?? "").trim();
	if (env !== "") candidates.push(env);
	const derived = defaultConfigRoot();
	if (derived !== undefined) candidates.push(derived);
	return candidates;
}

/**
 * The absolute path of the auth-session file a given config root points at.
 */
export function authSessionPathIn(configRoot) {
	return join(String(configRoot), "userData", AUTH_SESSION_FILENAME);
}

/** The plugin's own settings file — the same convention the sibling plugins use. */
export function settingsFilePath() {
	return join(homedir(), ".dsh", "dsh-connect-loomy.settings.json");
}
