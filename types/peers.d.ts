/**
 * Ambient declarations for host-provided globals and peer packages.
 *
 * `@deepseek-ai/*` and `@earendil-works/pi-ai` resolve from the Harness at
 * runtime and are declared here only so `tsc --allowJs --checkJs` can check
 * THIS plugin's JSDoc-annotated sources without pinning the host's own
 * (version-varying) type surface. They deliberately resolve to `any`.
 *
 */

declare module "react";
declare module "react/jsx-runtime";
declare module "@deepseek-ai/schemastery";
declare module "@deepseek-ai/dsh-llm";
declare module "@deepseek-ai/dsh-llm-pi-ai";
declare module "@deepseek-ai/dsh-host-webserver";
declare module "@deepseek-ai/cordis";
declare module "@earendil-works/pi-ai";
declare module "@earendil-works/pi-ai/api/openai-completions.lazy";

export {};
