/**
 * The read-only web routes the settings card consumes.
 *
 * Mounted on the host web server via a NESTED `ctx.inject(["webServer"], ...)`
 * — the service mounts late and may never appear, and naming it at the top
 * level would hold the whole plugin back.
 *
 * Security posture: the host's Connection fence FIRST — Host/Origin checks plus
 * the browser credential every DSH UI request carries. `webServer.register`
 * routes sit outside that fence, so without it a cross-site `fetch` and a plain
 * top-level navigation (which sends no `Origin` header) both reach these
 * handlers. The sibling-convention checks below (loopback Host header, no
 * cross-site fetches, loopback Origin, number-only allow-listed responses,
 * `no-store`, and for the one write route a custom CSRF fence header) stay as
 * defence in depth and as the fallback for Harness builds without `connection`.
 *
 * @module dsh-connect-loomy/routes
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const LOOMY_QUOTA_PATH = "/plugins/dsh-connect-loomy/quota";
export const LOOMY_CATALOG_PATH = "/plugins/dsh-connect-loomy/catalog";
export const LOOMY_STATUS_PATH = "/plugins/dsh-connect-loomy/status";
export const LOOMY_SAVE_PATH = "/plugins/dsh-connect-loomy/__save";

function loopbackHostHeader(req) {
	const host = req.headers.host;
	if (host === undefined || String(host).trim() === "") return false;
	try {
		return LOOPBACK_HOSTS.has(new URL(`http://${host}`).hostname);
	} catch {
		return false;
	}
}

function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === undefined || String(origin).trim() === "") return true;
	try {
		return LOOPBACK_HOSTS.has(new URL(origin).hostname);
	} catch {
		return false;
	}
}

/**
 * The host's Connection trust fence, when this build exposes one.
 *
 * `requestRejection` applies DSH's own Host/Origin checks AND requires the
 * browser credential the desktop UI carries on every same-origin request. It
 * returns 401/403 for a request that must not be served, `undefined` when the
 * route may proceed. Absent service (older Harness) or absent method leaves the
 * local header checks as the only gate, which is the previous behaviour.
 *
 * @param {object} ctx the webServer-injected Cordis context
 * @param {object} req the node:http request
 * @returns {401 | 403 | undefined}
 */
function connectionRejection(ctx, req) {
	const anyCtx = /** @type {any} */ (ctx);
	let connection;
	try {
		connection = typeof anyCtx.get === "function" ? anyCtx.get("connection") : anyCtx.connection;
	} catch {
		// A service lookup that throws means "not resolvable here", not "reject":
		// the local header checks below still stand in for the old behaviour.
		return undefined;
	}
	const requestRejection = connection?.requestRejection;
	if (typeof requestRejection !== "function") return undefined;
	try {
		const rejection = requestRejection.call(connection, req);
		return rejection === 401 || rejection === 403 ? rejection : undefined;
	} catch (error) {
		// A throwing fence is a host bug, not a licence to serve: fail closed.
		return 403;
	}
}

/** One gate for every route: host fence first, then the cheap local checks. */
function guard(ctx, req, res, { write = false } = {}) {
	const rejection = connectionRejection(ctx, req);
	if (rejection !== undefined) {
		json(res, rejection, { error: rejection === 401 ? "not-authenticated" : "origin-not-trusted" });
		return false;
	}
	if (!loopbackHostHeader(req)) {
		json(res, 403, { error: "host-not-loopback" });
		return false;
	}
	if (req.headers["sec-fetch-site"] === "cross-site") {
		json(res, 403, { error: "origin-not-trusted" });
		return false;
	}
	if (!loopbackOrigin(req)) {
		json(res, 403, { error: "origin-not-trusted" });
		return false;
	}
	if (write === true && req.headers["x-dsh-loomy-write"] === undefined) {
		json(res, 403, { error: "missing-write-header" });
		return false;
	}
	return true;
}

function json(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	});
	res.end(body);
}

function safeMessage(error) {
	return String(error?.message ?? "unknown error").slice(0, 200);
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 1_048_576) {
				reject(Object.assign(new Error("body too large"), { statusCode: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

/**
 * Register every route. Returns one combined disposer.
 *
 * @param {object} ctx a Cordis context that has `webServer`; it also carries
 *   `connection` when this Harness exposes one, read per request so the fence
 *   applies even though only `webServer` was injected
 * @param {object} deps
 * @param {(options?: { force?: boolean }) => Promise<object>} deps.quotaView async allow-listed quota view
 * @param {() => { refresh?: (options?: { force?: boolean }) => Promise<unknown> }} deps.discovery
 * @param {() => Promise<{ ok: boolean, models: Array<{ id: string, name: string }>, enabled: string[] | null }>} deps.catalogView allow-listed catalog view
 * @param {() => object} deps.statusView synchronous diagnostics snapshot
 * @param {() => Set<string>} deps.writableFields the persistable field allow-list
 * @param {(field: string, value: unknown) => void} deps.writeField persisted write
 * @param {() => object} deps.readSettings persisted read
 * @param {(field: string, value: unknown) => void} deps.onApplied applied-write hook
 * @param {() => void} [deps.onCatalogRefreshed] post-refresh hook for the catalog route
 */
export function registerLoomyRoutes(ctx, deps) {
	const disposers = [];

	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: LOOMY_QUOTA_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "POST") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!guard(ctx, req, res, { write: req.method === "POST" })) return;
			try {
				json(res, 200, await deps.quotaView({ force: req.method === "POST" }));
			} catch (error) {
				json(res, 500, { ok: false, error: safeMessage(error) });
			}
		},
	}));

	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: LOOMY_CATALOG_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "POST") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!guard(ctx, req, res, { write: req.method === "POST" })) return;
			if (req.method === "POST") {
				try {
					await deps.discovery().refresh?.({ force: true });
				} catch {}
				deps.onCatalogRefreshed?.();
			}
			try {
				json(res, 200, await deps.catalogView());
			} catch (error) {
				json(res, 500, { ok: false, error: safeMessage(error) });
			}
		},
	}));

	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: LOOMY_STATUS_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!guard(ctx, req, res)) return;
			json(res, 200, deps.statusView());
		},
	}));

	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: LOOMY_SAVE_PATH,
		handler: async (req, res) => {
			if (req.method !== "POST" && req.method !== "GET") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!guard(ctx, req, res, { write: req.method === "POST" })) return;
			if (req.method === "GET") {
				try {
					json(res, 200, { ok: true, value: deps.readSettings() });
				} catch (error) {
					json(res, 500, { ok: false, error: safeMessage(error) });
				}
				return;
			}
			try {
				const body = await readJsonBody(req);
				const field = body?.field;
				if (typeof field !== "string" || !deps.writableFields().has(field)) {
					json(res, 400, { error: `field must be one of: ${[...deps.writableFields()].join(", ")}` });
					return;
				}
				const value = body?.value;
				deps.writeField(field, value);
				deps.onApplied(field, value);
				json(res, 200, { ok: true, value: deps.readSettings() });
			} catch (error) {
				json(res, 500, { ok: false, errorName: error?.name ?? "unknown", error: safeMessage(error) });
			}
		},
	}));

	return () => {
		for (const dispose of disposers) {
			try {
				dispose?.();
			} catch {}
		}
		disposers.length = 0;
	};
}
