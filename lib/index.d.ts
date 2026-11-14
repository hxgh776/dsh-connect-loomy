/**
 * Type declarations for `dsh-connect-loomy` — the shape the host, the client
 * half, and the CLI tools rely on. The implementation is plain ESM JavaScript.
 */

export const LOOMY_PROVIDER: "loomy";
export const LOOMY_PROVIDER_DISPLAY_NAME: string;
export const PLUGIN_ID: "dsh-connect-loomy";
export const PLUGIN_NAME: string;
export const LOOMY_VERSION: string;
export const DEFAULT_BASE_URL: string;

export interface LoomyModelRow {
	id: string;
	name?: string;
	type?: string;
	protocol?: string;
	context_length?: number;
	max_output_tokens?: number;
	capabilities?: {
		reasoning?: boolean;
		vision?: boolean;
		function_calling?: boolean;
		streaming?: boolean;
		input_modalities?: string[];
		output_modalities?: string[];
	};
	reasoning_efforts?: string[];
	default_reasoning_effort?: string;
	created?: number;
}

export interface PiAiModelDescriptor {
	id: string;
	name: string;
	api: "openai-completions";
	provider: string;
	baseUrl: string;
	input: string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	contextWindow: number;
	maxTokens: number;
	compat: { supportsReasoningEffort: boolean };
}

/** Normalize raw gateway rows into the chat models a picker may offer. */
export function chatModelsOf(rows: unknown[]): LoomyModelRow[];
/** Filter normalized rows by the enabled-ids selection (undefined = all). */
export function enabledModelsOf(rows: LoomyModelRow[], enabledIds: string[] | undefined): LoomyModelRow[];
/** Build one pi-ai model descriptor from a normalized row. */
export function toPiModel(row: LoomyModelRow, baseUrl: string, providerId?: string): PiAiModelDescriptor;
/** `{id, name}` rows the settings card's checklist renders. */
export function catalogEntriesOf(rows: LoomyModelRow[]): Array<{ id: string; name: string }>;

export type LoomyErrorKind =
	| "not_signed_in"
	| "session_dead"
	| "network"
	| "upstream"
	| "client"
	| "rate_limited";

export class LoomyError extends Error {
	constructor(message: string, kind: LoomyErrorKind, meta?: { httpStatus?: number; cause?: unknown });
	kind: LoomyErrorKind;
	httpStatus?: number;
}

export interface LoomySession {
	session: string;
	userid: string;
	phone?: string;
	updatedAt?: number;
	/** Absolute path of the auth-session file the session was read from. */
	path: string;
}

/** Read the signed-in Loomy session (read-only, short TTL), or undefined. */
export function readLoomySession(configRoot?: string): LoomySession | undefined;
export function hasLoomySession(configRoot?: string): boolean;
export function invalidateCredentialCache(): void;

export function userHashOf(username?: string): string;
export function defaultConfigRoot(): string | undefined;
export function configRootCandidates(configRoot?: string): string[];
export function authSessionPathIn(configRoot: string): string;
export function settingsFilePath(): string;
export const AUTH_SESSION_FILENAME: string;

export interface LoomyUpstreamOptions {
	configRoot?: () => string;
	baseUrl?: () => string;
	timeoutMs?: number;
}

export interface LoomyCredits {
	balance: number;
	dailyBalance: number;
	availableBalance: number;
	dailyCycleDate?: string;
	ledger: Array<{
		description: string;
		direction: string;
		points: number;
		createdAt?: number;
		dailyCycleDate?: string;
	}>;
}

export class LoomyUpstream {
	constructor(options?: LoomyUpstreamOptions);
	baseUrl(): string;
	listModels(): Promise<LoomyModelRow[]>;
	chatCompletion(body: object, options?: { signal?: AbortSignal }): Promise<Response>;
	fetchCredits(options?: { pageSize?: number }): Promise<LoomyCredits>;
	probeIdentity(): Promise<unknown>;
}

export function buildLoomyHeaders(options?: {
	session?: string;
	chatId?: string;
	purpose?: string;
	stream?: boolean;
}): Record<string, string>;
export function generateTraceparent(): string;

export interface LoomyShim {
	ready: Promise<void>;
	token(): string;
	baseUrl(): string;
	baseUrlSync(): string | undefined;
	close(): void;
}

export function createLoomyShim(options: {
	upstream: LoomyUpstream;
	modelsProvider: () => LoomyModelRow[] | undefined;
	creditsProvider?: () => object | undefined;
}): LoomyShim;

export function createLoomyAdapter(options: {
	baseUrl: () => string;
	modelsProvider: () => LoomyModelRow[];
	resolveToken: () => string;
	providerId?: string;
	displayName?: string;
}): { adapter: unknown; provider: unknown; profile: unknown; generation: "legacy" | "modern" };

export interface LoomyCreditsView {
	ok: boolean;
	signedIn: boolean;
	points: {
		balance: number;
		dailyBalance: number;
		availableBalance: number;
		dailyCycleDate: string | null;
	} | null;
	ledger: Array<{
		description: string;
		direction: string;
		points: number;
		createdAt: number | null;
		dailyCycleDate: string | null;
	}>;
	error: string | null;
	errorKind: string | null;
}

export function createLoomyCredits(
	upstream: LoomyUpstream,
	configRoot: () => string,
): {
	refresh(options?: { force?: boolean }): Promise<LoomyCredits | undefined>;
	snapshot(): LoomyCredits | undefined;
	invalidate(): void;
	view(options?: { force?: boolean }): Promise<LoomyCreditsView>;
};

export function createLoomyDiscovery(upstream: LoomyUpstream): {
	refresh(options?: { force?: boolean }): Promise<"gateway" | "cache" | "fallback">;
	current(): LoomyModelRow[];
	describe(): { source: "gateway" | "cache" | "fallback"; count: number; fetchedAt?: number };
	invalidate(): void;
};

export const LOOMY_QUOTA_PATH: string;
export const LOOMY_CATALOG_PATH: string;
export const LOOMY_STATUS_PATH: string;
export const LOOMY_SAVE_PATH: string;
export function registerLoomyRoutes(ctx: any, deps: any): () => void;

export const WRITABLE_FIELDS: Set<string>;
export function readStoredSettings(path?: string): { enabledModelIds?: string[]; configRoot?: string; baseUrl?: string };
export function withStoredSettings(config: unknown, path?: string): { enabledModelIds: string[]; configRoot: string; baseUrl: string };
export function writeStoredSetting(
	field: "enabledModelIds" | "configRoot" | "baseUrl",
	value: string[] | string,
	path?: string,
): void;

/** The schemastery settings schema the Loader reads. */
export const Config: unknown;
/** The plugin's Cordis name — MUST equal the Loader entry id. */
export const name: "dsh-connect-loomy";
/** Required services; webServer/settings are nested injects inside apply. */
export const inject: string[];
export function apply(ctx: any, config?: any): void;
export function settingsNamespaceOf(ctx: any): string;
export function effectiveIds(config: unknown): string[] | undefined;
export function sessionStateOf(configRoot?: string): object;
declare const src_default: { name: typeof name; inject: typeof inject; apply: typeof apply };
export default src_default;
