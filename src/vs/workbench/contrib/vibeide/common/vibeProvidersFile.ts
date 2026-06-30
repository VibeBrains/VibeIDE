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

export type VibeProviderProtocol = 'openai' | 'anthropic' | 'gemini';

/** Auth shorthand `"bearer"` or the explicit object form. `header`/`query` carry the field name. */
export type VibeProviderAuth =
	| { readonly type: 'bearer' }
	| { readonly type: 'header'; readonly name: string }
	| { readonly type: 'query'; readonly name: string };

export type VibeModelToolFormat = 'openai' | 'anthropic' | 'gemini' | 'none';
export type VibeModelSystemMessage = 'system' | 'developer' | 'separated' | false;

export interface VibeProviderModelReasoning {
	readonly canTurnOff?: boolean;
	/** Payload field carrying the reasoning toggle/effort (e.g. `thinking`, `reasoning_effort`). */
	readonly field?: string;
	/** Allowed effort values, e.g. `["low","high"]`. */
	readonly effort?: readonly string[];
	/** Inline think-tag pair stripped from content, e.g. `["<think>","</think>"]`. */
	readonly thinkTags?: readonly [string, string];
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

	readonly contextWindow?: number;
	readonly maxOutputTokens?: number;
	readonly toolFormat?: VibeModelToolFormat;
	readonly vision?: boolean;
	readonly systemMessage?: VibeModelSystemMessage;
	readonly fim?: boolean;
	readonly reasoning?: false | VibeProviderModelReasoning;

	readonly cost?: { readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number };
	readonly temperature?: number;
	readonly topP?: number;
	readonly topK?: number;
	/** Extra fields merged into the request body (provider/model quirks). */
	readonly extraBody?: Readonly<Record<string, unknown>>;
	readonly note?: string;
}

export interface VibeProviderModelsSpec {
	/** `true` (or omitted — default) = auto-list from `<baseURL>/models`; a string = fetch that URL;
	 *  `false` = static only (no catalog). Auto-listed models merge with `static` (same id → static
	 *  overlays caps). */
	readonly fetch?: boolean | string;
	readonly static?: readonly VibeProviderModelEntry[];
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
	readonly auth?: VibeProviderAuth | 'bearer';
	/** API key from an environment variable (key never stored in the file). */
	readonly apiKeyEnv?: string;
	/** API key from VibeIDE's secure settings, by provider id. */
	readonly apiKeyRef?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly query?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
	readonly docsUrl?: string;
	readonly apiKeyUrl?: string;

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
	/** Non-fatal issues — e.g. an entry skipped for a missing `id`. */
	readonly warnings: readonly string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Normalize the `auth` shorthand to its object form. Defaults to bearer. */
export function normalizeAuth(auth: VibeProviderEntry['auth']): VibeProviderAuth {
	if (auth === 'bearer' || auth === undefined) { return { type: 'bearer' }; }
	if (isObject(auth) && (auth.type === 'bearer' || auth.type === 'header' || auth.type === 'query')) {
		return auth as VibeProviderAuth;
	}
	return { type: 'bearer' };
}

/**
 * Parse + structurally validate a `.vibe/providers.json`. JSONC comments are tolerated.
 * Malformed individual entries are skipped (recorded in `warnings`) so one typo doesn't disable
 * every provider. A top-level problem (not JSON / no `providers` array) returns `ok:false`.
 */
export function parseProvidersFile(raw: string | undefined | null): VibeProvidersParseResult {
	const parsed = safeParseConfigJson(raw);
	if (!parsed.ok) {
		return { ok: false, error: parsed.reason, providers: [], warnings: [] };
	}
	const root = parsed.value;
	if (!isObject(root) || !Array.isArray(root.providers)) {
		return { ok: false, error: 'missing-providers-array', providers: [], warnings: [] };
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

	return { ok: true, providers, warnings };
}

/**
 * Merge an override entry onto a base (used by both `extends` and same-id patching).
 * Top-level scalar/object fields: override wins when present. `models.static` is merged BY MODEL
 * ID — an override model patches the base model with the same id; new ids are appended; setting
 * `models.fetch` replaces the base's. The base is never mutated.
 */
export function mergeProviderEntry(base: VibeProviderEntry, override: VibeProviderEntry): VibeProviderEntry {
	const merged: Record<string, unknown> = { ...base, ...override };
	// `extends` is a resolution directive, not a persisted field — drop it from the result.
	delete merged.extends;

	if (base.models || override.models) {
		const baseModels = base.models?.static ?? [];
		const overModels = override.models?.static ?? [];
		const byId = new Map<string, VibeProviderModelEntry>();
		for (const m of baseModels) { byId.set(m.id, m); }
		for (const m of overModels) { byId.set(m.id, byId.has(m.id) ? { ...byId.get(m.id)!, ...m } : m); }
		const fetchSpec = override.models?.fetch ?? base.models?.fetch;
		merged.models = {
			...(fetchSpec !== undefined ? { fetch: fetchSpec } : {}),
			...(byId.size > 0 ? { static: [...byId.values()] } : {}),
		} satisfies VibeProviderModelsSpec;
	}

	return merged as unknown as VibeProviderEntry;
}
