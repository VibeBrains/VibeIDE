/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `.vibe/providers.json` — user-editable provider definitions (JSONC; comments allowed).
 *
 * This module is the pure data layer for the format: TypeScript types (which double as the
 * canonical schema doc), parsing (via the JSONC-tolerant config parser), structural validation
 * (malformed entries are skipped with a warning, never crash the whole file), and the merge used
 * by both `extends` (clone a base into a new id) and same-id overrides (patch a built-in).
 *
 * No I/O and no provider runtime here — the service (vibeDynamicProvidersService) reads the file,
 * resolves `extends` against built-ins, and feeds the transport/catalog/UI. Keeping this layer
 * pure makes the format testable from `test/common/`.
 */

import { safeParseConfigJson } from './vibeConfigJsonParser.js';

// `openai-responses` — эндпоинт /v1/responses, а не диалект chat-completions: модель оттуда
// отвечает 404 на /v1/chat/completions и наоборот, поэтому значение всегда объявляется явно.
/** Announced retirement of a model. Both fields optional — a vendor may name a date, a successor, or neither. */
export interface VibeModelDeprecation {
	/** ISO date (`YYYY-MM-DD`) the vendor turns the model off. */
	readonly date?: string;
	/** Model id to move to. Shown as the suggested replacement. */
	readonly replacedBy?: string;
	/** Why / where announced — a link or a sentence. Kept so the claim can be checked, not believed. */
	readonly note?: string;
}

/** Rates per 1M tokens, as the vendor publishes them. */
export interface VibeProviderModelCost {
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	/** A cache write with the vendor's default lifetime (five minutes at Anthropic). */
	readonly cacheWrite?: number;
	/** A cache write that lives an hour — billed for a model with `cacheTtl: "1h"`; absent — twice `input`. */
	readonly cacheWrite1h?: number;
	/** Surcharge on a long prompt, when the vendor announces one — see `VibeProviderLongContext`. */
	readonly longContext?: VibeProviderLongContext;
	/** Price by the hour: the rates above are PEAK rates — see `VibeProviderTimeOfDay`. */
	readonly timeOfDay?: VibeProviderTimeOfDay;
}

/**
 * Цена по часу.
 *
 * The rates of the entry are the peak ones and every rate is multiplied by `offPeakFactor` outside the
 * peak: vendors (DeepSeek, Z.ai) state the off-peak price as a share of the peak one, and the entry
 * repeats their price list instead of recomputing it. The shape is the shared set's contract —
 * VibeIDEA reads the same block (`ProvidersFile.kt`).
 */
export interface VibeProviderTimeOfDay {
	/** Windows `HH:MM-HH:MM` in UTC, end excluded; a window may cross midnight, `24:00` is an end only. */
	readonly peakUtc?: readonly string[];
	/** Three-letter English days (`mon` … `sun`) the windows apply on; absent — every day. */
	readonly peakDays?: readonly string[];
	/**
	 * UTC dates `YYYY-MM-DD` that are off-peak all day, whatever the windows say: DeepSeek's peak excludes
	 * Chinese public holidays, and no weekly rule can name them
	 */
	readonly offPeakDates?: readonly string[];
	/** Multiplier on every rate outside the peak, e.g. `0.5`. */
	readonly offPeakFactor?: number;
}

/**
 * Надбавка за длинный промпт.
 *
 * Multipliers, not a second price table: vendors announce it as «N times» — «prompts with more than
 * 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request»
 * (GPT-6 Astra) — and a second table would drift from the first on the next change of the base rate.
 * The shape is the shared set's contract: VibeIDEA reads the same block.
 */
export interface VibeProviderLongContext {
	/** Threshold on the PROMPT length, strictly above: fresh input, cache reads and cache writes. */
	readonly overInputTokens?: number;
	/** Multiplier on the fresh-input rate. Absent — 1. */
	readonly input?: number;
	/** Multiplier on the cache rates, read and write alike. Absent — 1. */
	readonly cache?: number;
	/** Multiplier on the output rate. Absent — 1. */
	readonly output?: number;
}

export type VibeProviderProtocol = 'openai' | 'openai-responses' | 'anthropic' | 'gemini';

/**
 * Auth shorthand `"bearer"` / `"none"` or the explicit object form. `header`/`query` carry the field name
 * `none` is a server that takes no key: nothing is sent, whatever key sources the entry declares
 * A missing `name` takes the wire's default — see `keyPlacement`
 */
export type VibeProviderAuth =
	| { readonly type: 'bearer' }
	| { readonly type: 'none' }
	| { readonly type: 'header'; readonly name?: string }
	| { readonly type: 'query'; readonly name?: string };

export type VibeModelToolFormat = 'openai' | 'anthropic' | 'gemini' | 'none';
export type VibeModelSystemMessage = 'system' | 'developer' | 'separated' | false;

export interface VibeProviderModelReasoning {
	readonly canTurnOff?: boolean;
	// NOTE: there used to be a `field` here — the name of the payload key carrying the reasoning
	// toggle. It was never read by any code, and could not be: a key name alone is not enough,
	// because the VALUE shape differs per vendor (`{thinking:{type,budget_tokens}}` for Anthropic,
	// `{reasoning_effort:'high'}` for openai-compatible, `{thinking:{type:'disabled'}}` for GLM).
	// Removed rather than left as a promise. For a static toggle use the model's `extraBody`;
	// a dynamic one for config providers is a roadmap item, see «тумблер размышления».
	/** Allowed effort values, e.g. `["low","high"]`. */
	readonly effort?: readonly string[];
	/** Inline think-tag pair stripped from content, e.g. `["<think>","</think>"]`. */
	readonly thinkTags?: readonly [string, string];
	/**
	 * Body fields sent when reasoning is switched OFF, e.g. `{"thinking": {"type": "disabled"}}` for MiMo.
	 * Needed where «off» is a request of its own: without it no effort is sent and the vendor's default —
	 * reasoning on — applies.
	 */
	readonly off?: Readonly<Record<string, unknown>>;
}

export interface VibeProviderModelEntry {
	/** Model id sent to the API (required). */
	readonly id: string;
	readonly name?: string;
	/** Default true. `false` hides the model from selection. */
	readonly active?: boolean;
	/** Mark as the provider's default (auto-selected) model. */
	readonly default?: boolean;
	/** Surface first in the model list. */
	readonly pinned?: boolean;

	/**
	 * Wire format for THIS model, overriding the provider's `protocol`.
	 *
	 * Needed because an aggregator can serve one key over several wire formats and pick by model:
	 * OpenCode Go routes GLM/Kimi/DeepSeek to `/v1/chat/completions`, MiniMax and Qwen to
	 * `/v1/messages`, and Grok/GPT to `/v1/responses` — one `baseURL`, one key, three protocols.
	 * A per-provider declaration can only be right for part of such a catalogue.
	 *
	 * Weaker than the user's own «протокол API» override in Settings, stronger than the provider's
	 * `protocol` and the models.dev catalogue.
	 */
	readonly protocol?: VibeProviderProtocol;

	/**
	 * Vendor is retiring this model.
	 *
	 * Vendors announce a shutdown date in a changelog and then answer 404 on the day — the user
	 * finds out when the model stops replying, mid-task. Declaring it here turns that into a
	 * warning seen while choosing the model, which is the only moment when switching is cheap.
	 */
	readonly deprecation?: VibeModelDeprecation;
	/**
	 * The id is an alias the vendor re-points at new snapshots without notice (`-latest`, `~…`, a renamed
	 * model routed elsewhere). «Auto» prefers a fixed model over it, and the council and a plan say so.
	 */
	readonly floating?: boolean;

	readonly contextWindow?: number;
	readonly maxOutputTokens?: number;
	readonly toolFormat?: VibeModelToolFormat;
	/**
	 * How long the Anthropic prompt cache lives: `5m` (vendor default) or `1h`. The hour costs more to write
	 * and saves a full re-read after a pause longer than five minutes — a review, a CI wait. Anthropic protocol
	 * only; declare `cost.cacheWrite` at the rate of the chosen lifetime, or the spend report under-counts.
	 */
	readonly cacheTtl?: VibePromptCacheTtl;
	readonly vision?: boolean;
	readonly systemMessage?: VibeModelSystemMessage;
	readonly fim?: boolean;
	readonly reasoning?: false | VibeProviderModelReasoning;

	readonly cost?: VibeProviderModelCost;

	/**
	 * When the rate in `cost` stops being the rate.
	 *
	 * ISO date (`2026-09-25`) or a full instant (`2026-09-09T16:00:00Z`). The instant form exists
	 * because vendor deadlines are announced in local time — «24:00 UTC+8» — and a bare date would
	 * be wrong by most of a day, in the direction that costs money.
	 */
	readonly costValidUntil?: string;

	/**
	 * The rate that replaces `cost` once `costValidUntil` passes.
	 *
	 * Without it an expiry date says a promotion ends but not what follows, so nothing can be
	 * recalculated — and inventing a number would be worse than keeping the old one.
	 */
	readonly costAfter?: VibeProviderModelCost;

	/** Where the price change was announced. Kept so the claim can be checked, not believed. */
	readonly costNote?: string;
	readonly temperature?: number;
	readonly topP?: number;
	readonly topK?: number;
	/** Extra fields merged into the request body (provider/model quirks). */
	readonly extraBody?: Readonly<Record<string, unknown>>;

	/**
	 * How many tools this model is handed at once. Omitted (the default) = no limit, which is how
	 * every model behaved before this field existed.
	 *
	 * Weak and local models miss tool calls not because they do not know the protocol but because
	 * they drown in 44 built-ins plus MCP. The core tools are never cut, whatever the number says —
	 * see `common/prompt/toolBudget.ts`.
	 */
	readonly maxTools?: number;

	/**
	 * How much of the workspace file-system overview is pasted into the system prompt, in
	 * characters. Omitted = the global default (`vibeide.prompt.directoryOverviewChars`).
	 *
	 * The overview is the one part of the prompt that grows with the repository rather than with
	 * the task, so it is the part worth capping per model. Set it low for a small local model and
	 * it explores with tools instead of reading a truncated tree it cannot hold anyway.
	 */
	readonly maxPromptDirectoryChars?: number;

	readonly note?: string;
}

/** Lifetime of the Anthropic prompt cache that the vendor offers. */
export type VibePromptCacheTtl = '5m' | '1h';

/** A declared cache lifetime, or nothing for anything the vendor does not offer. */
export function promptCacheTtlOf(value: unknown): VibePromptCacheTtl | undefined {
	return value === '5m' || value === '1h' ? value : undefined;
}

export interface VibeProviderModelsSpec {
	/** `true` (or omitted — default) = auto-list from `<baseURL>/models`; a string = fetch that URL;
	 *  `false` = static only (no catalog). Auto-listed models merge with `static` (same id → static
	 *  overlays caps). */
	readonly fetch?: boolean | string;
	readonly static?: readonly VibeProviderModelEntry[];
}

/**
 * A router's own spelling of reasoning on the OpenAI wire
 * `openrouter`: one `reasoning` object for every routed model — `effort` or `max_tokens` inside, `effort: "none"` for off
 * (openrouter.ai/docs/use-cases/reasoning-tokens); OpenRouter does not name OpenAI's `reasoning_effort`
 */
export type VibeReasoningDialect = 'openrouter';

/** The declared dialect, nothing when absent, or `'invalid'` for a value no product reads — the loader names it */
export function reasoningDialectOf(value: unknown): VibeReasoningDialect | undefined | 'invalid' {
	if (value === undefined) { return undefined; }
	return value === 'openrouter' ? value : 'invalid';
}

/** The `quota` field of a provider: raw, as written; validated by `parseQuotaSpec`. */
export interface VibeProviderQuota {
	readonly url?: string;
	readonly format?: string;
}

export interface VibeProviderEntry {
	/** Unique key. Matching a built-in id PATCHES that built-in; a new id DEFINES a provider. */
	readonly id: string;
	/** Inherit all fields from another provider id (built-in or file entry), then override below. */
	readonly extends?: string;
	readonly name?: string;
	/** Default true. `false` disables the provider and all its models. */
	readonly active?: boolean;
	readonly order?: number;
	readonly tags?: readonly string[];
	readonly note?: string;

	readonly protocol?: VibeProviderProtocol;
	readonly baseURL?: string;
	readonly auth?: VibeProviderAuth | 'bearer' | 'none';
	/** API key from an environment variable (key never stored in the file). */
	readonly apiKeyEnv?: string;
	/** API key from VibeIDE's secure settings, by provider id. */
	readonly apiKeyRef?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly query?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
	/**
	 * The provider's models run on this machine — local-model optimizations, timeouts and the privacy hint follow it
	 * Absent: decided by the address (`isLocalAddress`); a localhost proxy to a cloud model declares `false`
	 */
	readonly runsLocally?: boolean;
	/**
	 * The endpoint accepts `prompt_cache_key` (OpenAI, xAI): IDE sends a key stable for the conversation so
	 * that its requests reach the server holding their cache. Off unless declared — a strict OpenAI-compatible
	 * vendor answers 400 to a field it does not know. See `common/promptCacheKey.ts`.
	 */
	readonly promptCacheKey?: boolean;
	/**
	 * How the endpoint spells reasoning on the OpenAI wire, when not as OpenAI does — see `VibeReasoningDialect`
	 * The shared set's contract with VibeIDEA: `openrouter`, the only dialect so far
	 */
	readonly reasoningDialect?: VibeReasoningDialect;
	readonly docsUrl?: string;
	readonly apiKeyUrl?: string;
	/**
	 * Where to ask the vendor what the subscription has left — see `common/subscriptionQuota.ts`. The shared set's
	 * contract with VibeIDEA: `{ url: https://…, format: minimax-token-plan | zai-monitor }`.
	 */
	readonly quota?: VibeProviderQuota;

	readonly models?: VibeProviderModelsSpec;
}

export interface VibeProvidersFile {
	readonly version?: number;
	readonly providers: readonly VibeProviderEntry[];
}

/** Outcome of validating a `.vibe/providers.json`: the well-formed entries plus per-entry warnings. */
export interface VibeProvidersParseResult {
	readonly ok: boolean;
	/** Top-level failure reason (empty file, not-JSON, no `providers` array). `undefined` on success. */
	readonly error?: string;
	readonly providers: readonly VibeProviderEntry[];
	/**
	 * The file's `routes` block — logical model names (`@fast` → `provider/model`), `null` — the name is banned
	 * Shared with VibeIDEA: any providers file may carry one, and the layers add up (`mergeModelRoutes`)
	 */
	readonly routes: Readonly<Record<string, string | null>>;
	/** Non-fatal issues — e.g. an entry skipped for a missing `id`. */
	readonly warnings: readonly string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The `auth` field in its object form, or `'invalid'` for a value no product reads
 * Absent reads as bearer here; where the key goes when no layer wrote `auth` is the wire's call — `keyPlacement`
 * Values are case-sensitive, as VibeIDEA reads them
 */
export function parseAuth(auth: unknown): VibeProviderAuth | 'invalid' {
	if (auth === undefined || auth === 'bearer') { return { type: 'bearer' }; }
	if (auth === 'none') { return { type: 'none' }; }
	if (isObject(auth)) {
		if (auth.type === 'bearer' || auth.type === 'none') { return { type: auth.type }; }
		if ((auth.type === 'header' || auth.type === 'query') && (auth.name === undefined || typeof auth.name === 'string')) {
			return typeof auth.name === 'string' ? { type: auth.type, name: auth.name } : { type: auth.type };
		}
	}
	return 'invalid';
}

/**
 * Normalize the `auth` shorthand to its object form
 * An unreadable value falls back to bearer, as in VibeIDEA; the loader warns about it (`parseAuth`)
 */
export function normalizeAuth(auth: VibeProviderEntry['auth']): VibeProviderAuth {
	const parsed = parseAuth(auth);
	return parsed === 'invalid' ? { type: 'bearer' } : parsed;
}

/** The entry declares a server that takes no key (`"auth": "none"`) */
export function isKeyless(entry: Pick<VibeProviderEntry, 'auth'>): boolean {
	return normalizeAuth(entry.auth).type === 'none';
}

/** Where a key goes on one request: headers and query parameters, both empty when nothing is sent */
export interface VibeKeyPlacement {
	readonly headers: Readonly<Record<string, string>>;
	readonly query: Readonly<Record<string, string>>;
}

const NO_PLACEMENT: VibeKeyPlacement = { headers: {}, query: {} };

/** The wire's own key header; the OpenAI wires have none of their own and take a Bearer */
function nativeKeyHeaderOf(wire: VibeProviderProtocol): string | undefined {
	return wire === 'anthropic' ? 'x-api-key' : wire === 'gemini' ? 'x-goog-api-key' : undefined;
}

/** Header name of `{ "type": "header" }` without `name` on a wire without a key header of its own */
const DEFAULT_KEY_HEADER = 'x-api-key';

/** Parameter name of `{ "type": "query" }` without `name` — the one Gemini documents */
const DEFAULT_KEY_PARAM = 'key';

/**
 * Where a provider's key goes on a request — one rule for every wire and for the model catalogue
 *
 * The shared set's contract with VibeIDEA (`testVectors/providerAuth.json`, `providers/README.md`):
 * What a file declares is sent as declared, and `bearer` is `Authorization: Bearer` on any wire
 * What no layer declares goes the wire's own way: `x-api-key` on anthropic, `x-goog-api-key` on gemini, Bearer on OpenAI
 * One vendor may serve one key over two wires and read it from each wire's own header (OpenCode does)
 *
 * @param declared the `auth` as the merged layers wrote it; `undefined` — no layer did, the wire decides
 * @param wire the protocol of the REQUEST: a model may speak another wire than its provider
 */
export function keyPlacement(declared: VibeProviderEntry['auth'], key: string | undefined, wire: VibeProviderProtocol): VibeKeyPlacement {
	if (!key) { return NO_PLACEMENT; }
	const native = nativeKeyHeaderOf(wire);
	if (declared === undefined) {
		return native ? { headers: { [native]: key }, query: {} } : { headers: { Authorization: `Bearer ${key}` }, query: {} };
	}
	const auth = normalizeAuth(declared);
	switch (auth.type) {
		case 'none': return NO_PLACEMENT;
		case 'query': return { headers: {}, query: { [auth.name || DEFAULT_KEY_PARAM]: key } };
		case 'header': return { headers: { [auth.name || native || DEFAULT_KEY_HEADER]: key }, query: {} };
		// `bearer`, and anything unrecognised — the loader warns about it
		default: return { headers: { Authorization: `Bearer ${key}` }, query: {} };
	}
}

/** `url` with `params` appended, after its own query string when it has one */
export function withQueryParams(url: string, params: Readonly<Record<string, string>>): string {
	const pairs = Object.entries(params).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
	if (pairs.length === 0) { return url; }
	return `${url}${url.includes('?') ? '&' : '?'}${pairs.join('&')}`;
}

/** A declared protocol as a wire; anything the format does not know is the OpenAI-compatible default */
export function wireOfProtocol(protocol: string | undefined): VibeProviderProtocol {
	return protocol === 'anthropic' || protocol === 'gemini' || protocol === 'openai-responses' ? protocol : 'openai';
}

/** What a model-catalogue request of a file provider needs from the provider */
export interface VibeCatalogSource {
	readonly baseURL: string;
	/** The provider's `protocol` as written; the catalogue is asked over this wire */
	readonly protocol?: string;
	readonly auth?: VibeProviderEntry['auth'];
	readonly headers?: Readonly<Record<string, string>>;
	readonly query?: Readonly<Record<string, string>>;
	/** `models.fetch` as a string: the catalogue's own address */
	readonly modelsUrl?: string;
}

/** One model-catalogue request, ready to send */
export interface VibeCatalogRequest {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
}

/** Anthropic answers any request without it with an error, `/v1/models` included */
const ANTHROPIC_VERSION_HEADER = 'anthropic-version';
const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * The model-catalogue request of a file provider — asked the way its chat is asked
 * The address is `<baseURL>/models`, the path appended as is, like the chat's; `models.fetch` as a string replaces it
 * The file's `headers` and `query` go along, and the key goes where `keyPlacement` puts it on the provider's wire
 */
export function catalogRequestOf(source: VibeCatalogSource, key: string | undefined): VibeCatalogRequest {
	const wire = wireOfProtocol(source.protocol);
	const placement = keyPlacement(source.auth, key, wire);
	const address = source.modelsUrl?.trim() || `${source.baseURL.replace(/\/+$/, '')}/models`;
	const headers: Record<string, string> = { ...source.headers, ...placement.headers };
	const declaresVersion = Object.keys(headers).some(name => name.toLowerCase() === ANTHROPIC_VERSION_HEADER);
	if (wire === 'anthropic' && !declaresVersion) {
		headers[ANTHROPIC_VERSION_HEADER] = ANTHROPIC_API_VERSION;
	}
	return { url: withQueryParams(address, { ...source.query, ...placement.query }), headers };
}

/**
 * Parse + structurally validate a `.vibe/providers.json`. JSONC comments are tolerated.
 * Malformed individual entries are skipped (recorded in `warnings`) so one typo doesn't disable
 * every provider. A top-level problem (not JSON / no `providers` array) returns `ok:false`.
 */
export function parseProvidersFile(raw: string | undefined | null): VibeProvidersParseResult {
	const parsed = safeParseConfigJson(raw);
	if (!parsed.ok) {
		return { ok: false, error: parsed.reason, providers: [], routes: {}, warnings: [] };
	}
	const root = parsed.value;
	if (!isObject(root) || !Array.isArray(root.providers)) {
		return { ok: false, error: 'missing-providers-array', providers: [], routes: {}, warnings: [] };
	}

	const providers: VibeProviderEntry[] = [];
	const warnings: string[] = [];
	const seenIds = new Set<string>();

	for (let i = 0; i < root.providers.length; i++) {
		const p = root.providers[i];
		if (!isObject(p)) { warnings.push(`providers[${i}] is not an object — skipped`); continue; }
		if (typeof p.id !== 'string' || !p.id.trim()) { warnings.push(`providers[${i}] has no "id" — skipped`); continue; }
		if (seenIds.has(p.id)) { warnings.push(`duplicate provider id "${p.id}" — later entry ignored`); continue; }
		seenIds.add(p.id);
		providers.push(p as unknown as VibeProviderEntry);
	}

	return { ok: true, providers, routes: parseRoutes(root.routes, warnings), warnings };
}

/** The `routes` block: a text is a target, `null` bans the name; anything else is named and skipped */
function parseRoutes(raw: unknown, warnings: string[]): Readonly<Record<string, string | null>> {
	if (raw === undefined) { return {}; }
	if (!isObject(raw)) {
		warnings.push('routes — не объект, логические имена из файла не читаются');
		return {};
	}
	const routes: Record<string, string | null> = {};
	for (const [name, target] of Object.entries(raw)) {
		if (target === null || typeof target === 'string') {
			routes[name] = target;
		} else {
			warnings.push(`routes.${name} — не строка и не null, имя пропущено`);
		}
	}
	return routes;
}

/**
 * Files of the seeded `providers/` catalogue that are NOT provider definitions. VibeIDEA keeps its
 * catalogue bookkeeping next to the entries; reading those as providers would surface bogus ids.
 */
const CATALOGUE_NON_PROVIDER_FILES: ReadonlySet<string> = new Set(['versions.json', 'deprecated.json', 'bump.mjs']);

/** Is this catalogue file a provider definition? Case-insensitive; only `.json`/`.jsonc` qualify. */
export function isProviderCatalogueFile(fileName: string): boolean {
	const lower = fileName.toLowerCase();
	if (CATALOGUE_NON_PROVIDER_FILES.has(lower)) { return false; }
	return lower.endsWith('.json') || lower.endsWith('.jsonc');
}

/**
 * Merge provider layers, weakest first. Later layers override earlier ones by id, field by field
 * (`models.static` merges by model id) — `mergeProvidersLists` applied along the chain.
 *
 * The order the caller must use, weakest to strongest:
 *   `~/.vibe/providers/*.jsonc` → `<ws>/.vibe/providers/*.jsonc` → `~/.vibe/providers.json` → `<ws>/.vibe/providers.json`
 *
 * Why the catalogue is the WEAKEST layer, below both hand-written files: it is seeded into every
 * project and plays the role built-in providers play elsewhere. Ranked above the user's own files
 * it would silence live config — a seeded `"active": false` would switch off a provider the user
 * enabled globally. (VibeIDEA hit exactly that in review; decision of 2026-08-28.)
 */
export function mergeProviderLayers(layers: readonly (readonly VibeProviderEntry[])[]): VibeProviderEntry[] {
	return layers.reduce<VibeProviderEntry[]>((acc, layer) => mergeProvidersLists(acc, layer), []);
}

/**
 * Merge the GLOBAL (`~/.vibe/providers.json`) and WORKSPACE (`<folder>/.vibe/providers.json`)
 * provider lists into the single active set. Same semantics as VS Code settings: the workspace
 * entry wins — field-level, via `mergeProviderEntry` (so a workspace entry can override just one
 * field of a global provider; `models.static` merges by model id). Order: global entries first (in
 * file order, patched in place when the workspace overrides them), then workspace-only entries —
 * so a provider keeps its position regardless of which file patches it. Pure → unit-testable.
 */
export function mergeProvidersLists(global: readonly VibeProviderEntry[], workspace: readonly VibeProviderEntry[]): VibeProviderEntry[] {
	const workspaceById = new Map<string, VibeProviderEntry>(workspace.map(e => [e.id, e]));
	const merged: VibeProviderEntry[] = [];
	for (const g of global) {
		const w = workspaceById.get(g.id);
		if (w) {
			// `mergeProviderEntry` drops `extends` (it is a resolution directive, consumed when merging a
			// base into its extender) — but HERE both sides are unresolved file entries, so a surviving
			// `extends` must be kept for the later resolution pass. Workspace's directive wins.
			const combined = mergeProviderEntry(g, w);
			const ext = w.extends ?? g.extends;
			merged.push(ext ? { ...combined, extends: ext } : combined);
			workspaceById.delete(g.id);
		} else {
			merged.push(g);
		}
	}
	for (const w of workspace) {
		if (workspaceById.has(w.id)) { merged.push(w); }
	}
	return merged;
}

/** A model patched by a later layer; like a provider, a model the patch names without `active` is ON */
function modelOverlay(base: VibeProviderModelEntry, over: VibeProviderModelEntry): VibeProviderModelEntry {
	const merged: VibeProviderModelEntry = { ...base, ...over };
	if (over.active === undefined) {
		const { active: _inherited, ...rest } = merged;
		return rest;
	}
	return merged;
}

/**
 * Merge an override entry onto a base (used by both `extends` and same-id patching).
 * Top-level scalar/object fields: override wins when present. `models.static` is merged BY MODEL
 * ID — an override model patches the base model with the same id; new ids are appended; setting
 * `models.fetch` replaces the base's. `active` is the override's alone: absent means ON, as in VibeIDEA.
 * `headers` and `query` merge by name, as in VibeIDEA: a patch adding
 * one header keeps the base's others. The base is never mutated.
 */
export function mergeProviderEntry(base: VibeProviderEntry, override: VibeProviderEntry): VibeProviderEntry {
	const merged: Record<string, unknown> = { ...base, ...override };
	// `extends` is a resolution directive, not a persisted field — drop it from the result.
	delete merged.extends;
	// An entry without `active` is ON, as VibeIDEA reads it and the spec says: a user's own entry over an inactive seed
	// comes out alive, and a patch that must keep its target off repeats `"active": false`
	if (override.active === undefined) { delete merged.active; }
	if (base.headers || override.headers) { merged.headers = { ...base.headers, ...override.headers }; }
	if (base.query || override.query) { merged.query = { ...base.query, ...override.query }; }

	if (base.models || override.models) {
		const baseModels = base.models?.static ?? [];
		const overModels = override.models?.static ?? [];
		const byId = new Map<string, VibeProviderModelEntry>();
		for (const m of baseModels) { byId.set(m.id, m); }
		for (const m of overModels) { byId.set(m.id, byId.has(m.id) ? modelOverlay(byId.get(m.id)!, m) : m); }
		const fetchSpec = override.models?.fetch ?? base.models?.fetch;
		merged.models = {
			...(fetchSpec !== undefined ? { fetch: fetchSpec } : {}),
			...(byId.size > 0 ? { static: [...byId.values()] } : {}),
		} satisfies VibeProviderModelsSpec;
	}

	return merged as unknown as VibeProviderEntry;
}
