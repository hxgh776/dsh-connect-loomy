/**
 * DSH Connect Loomy — browser half.
 *
 * This file is loaded by the desktop shell as a plain script (NOT an ES
 * module) and must stay CommonJS-shaped: the factory receives the host's
 * `require` and everything else lives inside it. An `import` statement at top
 * level kills the whole web boot with "1 entry did not activate".
 *
 * Registers one settings section ("设置 → Loomy") whose card shows the
 * read-only credits view and the model checklist. All data comes from this
 * plugin's own web routes — number-only allow-listed views; the session token
 * never crosses.
 */
window.__ModuleLoader__.load({
	id: "dsh-connect-loomy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region contract
		const PLUGIN_ID = "dsh-connect-loomy";
		const NAMESPACE = "settings.loomy";

		const LOOMY_QUOTA_PATH = "/plugins/dsh-connect-loomy/quota";
		const LOOMY_CATALOG_PATH = "/plugins/dsh-connect-loomy/catalog";
		const LOOMY_STATUS_PATH = "/plugins/dsh-connect-loomy/status";
		const LOOMY_SAVE_PATH = "/plugins/dsh-connect-loomy/__save";

		/** CSRF fence the host route requires on writes. */
		const WRITE_HEADERS = { "x-dsh-loomy-write": "1" };
		//#endregion

		//#region helpers
		/** Fetch a JSON route; never throws, returns undefined on failure. */
		async function fetchJson(path, options) {
			try {
				const response = await fetch(path, {
					credentials: "same-origin",
					...(options ?? {}),
				});
				if (!response.ok) return undefined;
				return await response.json();
			} catch {
				return undefined;
			}
		}

		async function fetchQuota(force, signal) {
			return await fetchJson(LOOMY_QUOTA_PATH, {
				method: force ? "POST" : "GET",
				signal,
				headers: { accept: "application/json", ...(force ? WRITE_HEADERS : {}) },
			});
		}

		async function fetchCatalog(refresh, signal) {
			return await fetchJson(LOOMY_CATALOG_PATH, {
				method: refresh ? "POST" : "GET",
				signal,
				headers: { accept: "application/json", ...(refresh ? WRITE_HEADERS : {}) },
			});
		}

		async function fetchStatus(signal) {
			return await fetchJson(LOOMY_STATUS_PATH, { method: "GET", signal, headers: { accept: "application/json" } });
		}

		async function saveField(field, value) {
			return await fetchJson(LOOMY_SAVE_PATH, {
				method: "POST",
				headers: { "Content-Type": "application/json", accept: "application/json", ...WRITE_HEADERS },
				body: JSON.stringify({ field, value }),
			});
		}

		function formatDateTime(seconds) {
			if (!Number.isFinite(seconds) || seconds <= 0) return "—";
			try {
				return new Date(seconds * 1000).toLocaleString();
			} catch {
				return "—";
			}
		}

		function directionLabel(direction, t) {
			if (direction === "credit") return t("ledger.credit");
			if (direction === "debit") return t("ledger.debit");
			return direction || "—";
		}
		//#endregion

		//#region styles
		function ensureLoomyStyles() {
			if (document.getElementById("dsh-connect-loomy-styles")) return;
			const el = document.createElement("style");
			el.id = "dsh-connect-loomy-styles";
			el.textContent = `
.lmy-card { display: flex; flex-direction: column; gap: 16px; max-width: 720px; }
.lmy-section-title { font-size: 14px; font-weight: 600; opacity: 0.9; }
.lmy-points { display: flex; gap: 16px; flex-wrap: wrap; }
.lmy-point { flex: 1 1 160px; border: 1px solid var(--dsh-border, rgba(128,128,128,0.25)); border-radius: 10px; padding: 12px 14px; }
.lmy-point-value { font-size: 22px; font-weight: 600; }
.lmy-point-label { font-size: 12px; opacity: 0.65; margin-top: 2px; }
.lmy-note { font-size: 12px; opacity: 0.6; }
.lmy-error { font-size: 12px; color: #d97706; }
.lmy-ledger { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.lmy-ledger-row { display: flex; justify-content: space-between; gap: 12px; opacity: 0.85; }
.lmy-models { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.lmy-model { display: flex; align-items: center; gap: 8px; border: 1px solid var(--dsh-border, rgba(128,128,128,0.25)); border-radius: 8px; padding: 8px 10px; font-size: 13px; }
.lmy-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.lmy-button { border: 1px solid var(--dsh-border, rgba(128,128,128,0.35)); border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; background: transparent; color: inherit; }
.lmy-button:disabled { opacity: 0.5; cursor: default; }
.lmy-badge { font-size: 11px; border-radius: 6px; padding: 2px 8px; border: 1px solid var(--dsh-border, rgba(128,128,128,0.3)); opacity: 0.8; }
`;
			document.head.appendChild(el);
		}
		//#endregion

		//#region card
		/**
		 * The Loomy settings card.
		 *
		 * Reads the quota + catalog + status routes; writes ONLY the enabled
		 * model id list through the save route. Everything is allow-listed on
		 * the host side — the card can render nothing secret even if it wanted.
		 */
		function LoomyQuotaCard(props) {
			const { t, settingsScope } = props;
			const [quota, setQuota] = react.useState(undefined);
			const [quotaBusy, setQuotaBusy] = react.useState(false);
			const [catalog, setCatalog] = react.useState(undefined);
			const [status, setStatus] = react.useState(undefined);
			const [selected, setSelected] = react.useState(null);
			const [saved, setSaved] = react.useState(false);
			const [saveError, setSaveError] = react.useState(null);

			const load = react.useCallback(async (refresh) => {
				setQuotaBusy(refresh === true);
				const [nextQuota, nextCatalog, nextStatus] = await Promise.all([
					fetchQuota(refresh === true),
					fetchCatalog(refresh === true),
					fetchStatus(),
				]);
				setQuota(nextQuota);
				setCatalog(nextCatalog);
				setStatus(nextStatus);
				if (nextCatalog?.ok) {
					setSelected((previous) => {
						if (previous !== null) return previous;
						if (Array.isArray(nextCatalog.enabled)) return nextCatalog.enabled;
						return null;
					});
				}
				setQuotaBusy(false);
			}, []);

			react.useEffect(() => {
				const controller = new AbortController();
				void load(false);
				return () => controller.abort();
			}, [load]);

			// A settings snapshot bump (another writer saved) re-reads the store.
			react.useEffect(() => {
				if (settingsScope === undefined) return;
				setSelected(null);
				void load(false);
			}, [settingsScope?.revision, load]);

			const points = quota?.points;
			const signedIn = quota?.signedIn === true || status?.session?.signedIn === true;

			const toggleModel = (id) => {
				const current = selected ?? [];
				const base = Array.isArray(catalog?.enabled) ? catalog.enabled : [];
				const currentSet = new Set(selected !== null ? current : base);
				if (currentSet.has(id)) currentSet.delete(id);
				else currentSet.add(id);
				setSelected([...currentSet]);
				setSaved(false);
				setSaveError(null);
			};

			const saveSelection = async () => {
				setSaveError(null);
				const value = selected ?? [];
				const result = await saveField("enabledModelIds", value);
				if (result?.ok === true) {
					setSaved(true);
					void load(false);
				} else {
					setSaveError(result?.error ?? t("save.failed"));
				}
			};

			const refreshCatalog = async () => {
				const next = await fetchCatalog(true);
				if (next?.ok) setCatalog(next);
				else setSaveError(t("models.catalogRefreshFailed"));
			};

			const ledger = Array.isArray(quota?.ledger) ? quota.ledger.slice(0, 8) : [];
			const models = Array.isArray(catalog?.models) ? catalog.models : [];

			return react_jsx_runtime.jsx("div", {
				className: "lmy-card",
				children: [
					react_jsx_runtime.jsx("div", {
						className: "lmy-section-title",
						children: `${t("card.title")} ${t("card.subtitle")}`,
					}, "title"),

					react_jsx_runtime.jsx("div", {
						className: "lmy-actions",
						children: [
							react_jsx_runtime.jsx("button", {
								className: "lmy-button",
								disabled: quotaBusy,
								onClick: () => void load(true),
								children: quotaBusy ? t("common.loading") : t("common.refresh"),
							}, "refresh"),
							react_jsx_runtime.jsx("span", {
								className: "lmy-badge",
								children: signedIn ? t("status.signedIn") : t("status.signedOut"),
							}, "badge"),
						],
					}, "actions"),

					!signedIn ? react_jsx_runtime.jsx("div", {
						className: "lmy-error",
						children: t("status.signedOutHint"),
					}, "signed-out") : null,

					points !== null && points !== undefined ? react_jsx_runtime.jsxs("div", {
						className: "lmy-points",
						children: [
							react_jsx_runtime.jsxs("div", { className: "lmy-point", children: [
								react_jsx_runtime.jsx("div", { className: "lmy-point-value", children: points.availableBalance }),
								react_jsx_runtime.jsx("div", { className: "lmy-point-label", children: t("points.available") }),
							] }, "available"),
							react_jsx_runtime.jsxs("div", { className: "lmy-point", children: [
								react_jsx_runtime.jsx("div", { className: "lmy-point-value", children: points.balance }),
								react_jsx_runtime.jsx("div", { className: "lmy-point-label", children: t("points.balance") }),
							] }, "balance"),
							react_jsx_runtime.jsxs("div", { className: "lmy-point", children: [
								react_jsx_runtime.jsx("div", { className: "lmy-point-value", children: points.dailyBalance }),
								react_jsx_runtime.jsx("div", { className: "lmy-point-label", children: t("points.daily") }),
							] }, "daily"),
						],
					}, "points") : null,

					points?.dailyCycleDate ? react_jsx_runtime.jsx("div", {
						className: "lmy-note",
						children: t("points.dailyCycle", { date: points.dailyCycleDate }),
					}, "daily-cycle") : null,

					quota?.error ? react_jsx_runtime.jsx("div", {
						className: "lmy-error",
						children: `${t("quota.errorPrefix")}${quota.error}`,
					}, "quota-error") : null,

					ledger.length > 0 ? react_jsx_runtime.jsxs("div", {
						children: [
							react_jsx_runtime.jsx("div", { className: "lmy-section-title", children: t("ledger.title") }, "ledger-title"),
							react_jsx_runtime.jsx("div", {
								className: "lmy-ledger",
								children: ledger.map((row, index) => react_jsx_runtime.jsxs("div", {
									className: "lmy-ledger-row",
									children: [
										react_jsx_runtime.jsx("span", { children: `${row.description || "—"} · ${formatDateTime(row.createdAt)}` }, `desc-${index}`),
										react_jsx_runtime.jsx("span", { children: `${directionLabel(row.direction, t)} ${row.points}` }, `points-${index}`),
									],
								}, `row-${index}`)),
							}, "ledger"),
						],
					}, "ledger-block") : null,

					react_jsx_runtime.jsxs("div", {
						children: [
							react_jsx_runtime.jsxs("div", { className: "lmy-section-title", children: [
								t("models.title"),
								catalog?.source ? react_jsx_runtime.jsx("span", { className: "lmy-note", children: ` (${t("models.source")}: ${catalog.source})` }) : null,
							] }, "models-title"),
							models.length > 0 ? react_jsx_runtime.jsx("div", {
								className: "lmy-models",
								children: models.map((model) => {
									const base = Array.isArray(catalog?.enabled) ? catalog.enabled : [];
									const checked = (selected !== null ? selected : base).includes(model.id);
									return react_jsx_runtime.jsxs("label", {
										className: "lmy-model",
										children: [
											react_jsx_runtime.jsx("input", {
												type: "checkbox",
												checked,
												onChange: () => toggleModel(model.id),
											}),
											react_jsx_runtime.jsx("span", { children: model.name || model.id }),
										],
									}, `model-${model.id}`);
								}),
							}, "models") : react_jsx_runtime.jsx("div", { className: "lmy-note", children: t("models.empty") }),
							react_jsx_runtime.jsxs("div", {
								className: "lmy-actions",
								children: [
									react_jsx_runtime.jsx("button", {
										className: "lmy-button",
										disabled: selected === null,
										onClick: () => void saveSelection(),
										children: t("save.apply"),
									}, "save"),
									react_jsx_runtime.jsx("button", {
										className: "lmy-button",
										onClick: () => void refreshCatalog(),
										children: t("models.refresh"),
									}, "refresh-catalog"),
									saved ? react_jsx_runtime.jsx("span", { className: "lmy-note", children: t("save.done") }, "saved") : null,
									saveError ? react_jsx_runtime.jsx("span", { className: "lmy-error", children: saveError }, "save-error") : null,
									selected !== null ? react_jsx_runtime.jsx("span", { className: "lmy-note", children: t("save.hintWhenUnticked") }, "hint") : null,
								],
							}, "save-row"),
						],
					}, "models-block"),

					status?.session?.sessionPath ? react_jsx_runtime.jsx("div", {
						className: "lmy-note",
						children: t("status.sessionPath", { path: status.session.sessionPath }),
					}, "session-path") : null,

					react_jsx_runtime.jsx("div", {
						className: "lmy-note",
						children: t("card.privacy"),
					}, "privacy"),
				],
			}, "root");
		}
		//#endregion

		//#region locale
		const zh = {
			"card.title": "Loomy（讯飞）",
			"card.subtitle": "· 复用本机已登录的 Loomy 账号",
			"card.navLabel": "Loomy",
			"card.privacy": "本插件只读取 Loomy 桌面端自身的登录态文件，不复制、不保存任何凭据；额度数据只读。",
			"common.refresh": "刷新",
			"common.loading": "加载中…",
			"status.signedIn": "已登录",
			"status.signedOut": "未登录",
			"status.signedOutHint": "未检测到本机 Loomy 登录态。请先打开 Loomy 桌面端登录，再回来刷新。",
			"status.sessionPath": "登录态文件：{{path}}",
			"points.available": "可用积分",
			"points.balance": "总积分余额",
			"points.daily": "每日额度",
			"points.dailyCycle": "每日额度按 Loomy 业务日（{{date}}）重置",
			"quota.errorPrefix": "额度读取失败：",
			"ledger.title": "最近积分变动",
			"ledger.credit": "获得",
			"ledger.debit": "消耗",
			"models.title": "模型清单",
			"models.source": "来源",
			"models.empty": "暂无模型（网关不可达且无缓存）",
			"models.refresh": "刷新目录",
			"models.catalogRefreshFailed": "目录刷新失败",
			"save.apply": "保存模型选择",
			"save.done": "已保存",
			"save.failed": "保存失败",
			"save.hintWhenUnticked": "未选择任何模型时展示全部",
		};

		const en = {
			"card.title": "Loomy (iFlytek)",
			"card.subtitle": " · reuses the locally signed-in Loomy account",
			"card.navLabel": "Loomy",
			"card.privacy": "This plugin only reads Loomy desktop's own auth-session file. Nothing is copied or stored; all quota data is read-only.",
			"common.refresh": "Refresh",
			"common.loading": "Loading…",
			"status.signedIn": "Signed in",
			"status.signedOut": "Not signed in",
			"status.signedOutHint": "No local Loomy session found. Sign in from the Loomy desktop app, then refresh here.",
			"status.sessionPath": "Session file: {{path}}",
			"points.available": "Available points",
			"points.balance": "Total balance",
			"points.daily": "Daily allowance",
			"points.dailyCycle": "Daily allowance resets on Loomy's business day ({{date}})",
			"quota.errorPrefix": "Quota read failed: ",
			"ledger.title": "Recent point changes",
			"ledger.credit": "earned",
			"ledger.debit": "spent",
			"models.title": "Models",
			"models.source": "source",
			"models.empty": "No models (gateway unreachable and no cache)",
			"models.refresh": "Refresh catalog",
			"models.catalogRefreshFailed": "Catalog refresh failed",
			"save.apply": "Save model selection",
			"save.done": "Saved",
			"save.failed": "Save failed",
			"save.hintWhenUnticked": "Nothing ticked serves the full catalog",
		};

		const translator = (key, params) => {
			const table = (typeof navigator !== "undefined" && String(navigator.language || "").toLowerCase().startsWith("zh") ? zh : en);
			let text = table[key] ?? zh[key] ?? key;
			if (params !== undefined && typeof text === "string") {
				for (const [name, value] of Object.entries(params)) {
					text = text.replaceAll(`{{${name}}}`, String(value));
				}
			}
			return text;
		};
		//#endregion

		//#region registration
		const name = "dsh-connect-loomy-client";
		const inject = ["slots", "locale"];

		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), "dsh-connect-loomy: card copy");
				const t = ctx.locale.bind(NAMESPACE);

				// Soft service probe: reading an undeclared property THROWS, so the
				// settings seat must be reached through ctx.get().
				const softGet = (serviceName) => ctx.get(serviceName);
				let settingsScope;
				const forms = softGet("configForms");
				if (forms !== undefined) {
					let ns = PLUGIN_ID;
					try {
						const served = (forms.describe().getSnapshot().view?.namespaces ?? [])
							.find((entry) => entry.ns === ns || /loomy/i.test(entry.ns));
						if (served !== undefined) ns = served.ns;
					} catch {}
					settingsScope = forms.get(ns);
				}

				const registerCard = (slotName, key) => {
					try {
						ctx.slots.inject(slotName, () => ctx.slots.register({
							name: slotName,
							key,
							priority: 30,
							inject: () => (settingsScope === undefined ? { t } : { t, settingsScope }),
						}, LoomyQuotaCard));
					} catch (error) {
						console.error(`[dsh-connect-loomy] card slot "${slotName}" failed to register (host provider unaffected):`, error);
					}
				};
				registerCard("plugins.bundle.config", PLUGIN_ID);
				registerCard("plugins.row.config", `${PLUGIN_ID}#${PLUGIN_ID}`);

				// Top-level entry in the SETTINGS LEFT-HAND NAV ("设置 → Loomy").
				// Descriptor fields here are id/order/label (NOT key/priority), per
				// the two plugins the sibling documents as provably appearing.
				try {
					ctx.slots.inject("settings.section", () => ctx.slots.register({
						name: "settings.section",
						id: PLUGIN_ID,
						order: 40,
						label: () => t("card.navLabel"),
						inject: () => (settingsScope === undefined ? { t } : { t, settingsScope }),
					}, LoomyQuotaCard));
				} catch (error) {
					console.error("[dsh-connect-loomy] settings.section failed to register (host provider unaffected):", error);
				}

				try {
					ensureLoomyStyles();
				} catch {}
			} catch (error) {
				console.error("[dsh-connect-loomy] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion

		exports.LoomyQuotaCard = LoomyQuotaCard;
		exports.apply = apply;
		exports.en = en;
		exports.inject = inject;
		exports.name = name;
		exports.translator = translator;
		exports.zh = zh;
		return module.exports;
	},
});
