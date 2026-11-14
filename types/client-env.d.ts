/**
 * The desktop shell's browser environment for `lib/client.js`.
 *
 * client.js is loaded as a plain CJS-shaped script (NOT an ES module): the
 * host registers it through `window.__ModuleLoader__.load({ id, factory })`
 * and the factory receives the host's `require`, which serves the packages
 * listed in `dsh.client.inject` plus react. Declared here so
 * `tsc --allowJs --checkJs` checks the card against the REAL react types.
 */

interface Window {
	__ModuleLoader__: {
		load(options: { id: string; factory: (require: (id: string) => any) => unknown }): void;
	};
}

declare function require(id: "react"): typeof import("react");
declare function require(id: "react/jsx-runtime"): typeof import("react/jsx-runtime");
declare function require(id: string): any;
