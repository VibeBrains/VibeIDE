/*--------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

/**
 * Types and validators for the model-quirks catalog.
 *
 * Source of truth: `resources/model-quirks.json` in this repo + CDN
 * (https://raw.githubusercontent.com/VibeIDETeam/VibeIDE/main/resources/model-quirks.json).
 *
 * Schema version is bumped only when fields are renamed/removed (breaking). Adding
 * new optional fields stays on the same version — older IDE installs ignore unknown
 * fields, newer installs use them. See `validateCatalog()` for the parser policy.
 */

/** Format the model uses for tool calls. Defaults to provider capabilities catalog. */
export type ToolCallFormat = 'native' | 'xml' | 'auto'

/**
 * One quirks rule.
 *
 * Matcher rules:
 * - `match`: case-insensitive substring of the model id (lowercased on both sides). Required.
 * - `provider` (optional): case-insensitive substring of the provider name. When
 *   present, rule applies ONLY to that provider. When absent, rule applies across
 *   all providers (broad behaviour). Lets us force XML for `kimi` via `openCode`
 *   while preserving native FC on direct Moonshot API where it works correctly.
 *
 * Order in the catalog = priority: first match wins (Array#find semantics). Place
 * more specific patterns above broader family patterns. Provider-scoped rules
 * should typically go ABOVE the same-model unscoped rule so the scoped variant
 * wins when its provider matches.
 *
 * All fields except `match` are optional — undefined = fall through to provider defaults.
 */
export interface ModelQuirksRule {
	/** Lowercase substring matched against modelId (also lowercased). */
	readonly match: string

	/** Optional case-insensitive provider-name substring. When set, rule applies only to that provider. */
	readonly provider?: string

	// ---------- Generation parameters ----------
	/** `temperature` for streamText / completion. Range typically 0..2. */
	readonly temperature?: number
	/** `topP` (nucleus sampling). Range 0..1. */
	readonly topP?: number
	/** `topK` (only some providers respect this). Positive integer. */
	readonly topK?: number

	// ---------- Message-level normalization ----------
	/**
	 * Force `{ type: 'reasoning', text: '' }` placeholder on every assistant message
	 * that lacks one. DeepSeek's API rejects continuations otherwise (HTTP 400 or
	 * silent empty stream).
	 */
	readonly forceEmptyReasoning?: boolean
	/**
	 * Mirror combined reasoning text into `providerOptions.openaiCompatible.reasoning_content`
	 * on the assistant message. Interleaved-reasoning families (DeepSeek, minimax-m2,
	 * kimi-k2-thinking) read this top-level field, not the AI-SDK content[] reasoning part.
	 */
	readonly mirrorReasoningContent?: boolean

	// ---------- Tool routing ----------
	/**
	 * Override default tool-call routing for this model.
	 * - `native` — force native function-calling regardless of catalog auto-downgrade.
	 * - `xml` — force XML-in-prompt grammar (use with `xmlToolGrammar`).
	 * - `auto` — respect `getModelCapabilities()` / runtime auto-downgrade (default).
	 */
	readonly forceToolCallFormat?: ToolCallFormat

	// ---------- Metadata ----------
	/** Free-text note for catalog contributors. Not consumed at runtime. */
	readonly note?: string
}

/** Catalog wire format. JSON shipped in `resources/model-quirks.json` and on CDN. */
export interface ModelQuirksCatalog {
	/** Schema version. Currently 1. Bump only on breaking changes. */
	readonly version: number
	/** Human-readable description; ignored at runtime. */
	readonly description?: string
	/** Pointer to schema/contribution docs; ignored at runtime. */
	readonly docs?: string
	/** Rules in priority order — first match wins. */
	readonly rules: readonly ModelQuirksRule[]
}

/**
 * Resolved quirks for a model. Same shape as `ModelQuirksRule` minus the matcher
 * key. Returned by `IModelQuirksService.getQuirks()` — empty object means
 * "no quirks, use provider defaults for everything".
 */
export type ResolvedModelQuirks = Omit<ModelQuirksRule, 'match' | 'note'>

/** Empty quirks — convenient sentinel. */
export const EMPTY_QUIRKS: ResolvedModelQuirks = Object.freeze({})

/**
 * Match a model id (and optional provider name) against catalog rules. Returns
 * resolved quirks (without `match` / `provider` / `note` fields) or null if no
 * rule matched.
 *
 * Match policy:
 * - `rule.match` must be a case-insensitive substring of `modelId`.
 * - When `rule.provider` is present, it must ALSO be a case-insensitive
 *   substring of `providerName`. When `rule.provider` is absent, the rule
 *   applies to all providers (legacy behaviour, backward-compatible with
 *   pre-per-provider catalogs).
 * - First match in array order wins. Provider-scoped rules should be listed
 *   above same-model unscoped rules so the scoped variant wins when its
 *   provider matches.
 *
 * Passing `providerName = ''` (or omitting it) skips provider matching — useful
 * for tests or when caller doesn't track provider context. Provider-scoped
 * rules are not considered in that case.
 */
export function matchQuirks(
	rules: readonly ModelQuirksRule[],
	modelId: string,
	providerName?: string,
): ResolvedModelQuirks | null {
	const modelNeedle = (modelId ?? '').toLowerCase()
	if (!modelNeedle) return null
	const providerNeedle = (providerName ?? '').toLowerCase()
	for (const rule of rules) {
		const modelPat = (rule.match ?? '').toLowerCase()
		if (!modelPat || !modelNeedle.includes(modelPat)) continue
		// Provider-scoped rule: only apply when provider also matches.
		if (rule.provider) {
			const providerPat = rule.provider.toLowerCase()
			if (!providerNeedle.includes(providerPat)) continue
		}
		const { match: _m, provider: _p, note: _n, ...rest } = rule
		return rest
	}
	return null
}

/**
 * Validate a parsed catalog object. Returns the catalog (typed) on success,
 * throws on hard schema violations (missing `version`, `rules` not array,
 * `match` not a string).
 *
 * Forward-compat policy: UNKNOWN top-level keys and UNKNOWN per-rule keys
 * are ignored, NOT rejected. Newer catalogs may add fields older IDEs don't
 * understand — those IDEs should still apply what they know. Throws only on
 * structural breakage that would crash downstream consumers.
 *
 * Numeric fields out of "sane" range are clamped (e.g. negative `topK` → drop).
 * Boolean fields with non-boolean values → drop. This prevents catalog typos
 * from breaking IDE startup.
 */
export function validateCatalog(raw: unknown): ModelQuirksCatalog {
	if (!raw || typeof raw !== 'object') {
		throw new Error('model-quirks: root is not an object')
	}
	const obj = raw as Record<string, unknown>
	const version = obj['version']
	if (typeof version !== 'number' || !Number.isFinite(version) || version < 1) {
		throw new Error(`model-quirks: invalid version ${JSON.stringify(version)}`)
	}
	const rawRules = obj['rules']
	if (!Array.isArray(rawRules)) {
		throw new Error('model-quirks: rules is not an array')
	}
	const rules: ModelQuirksRule[] = []
	for (let i = 0; i < rawRules.length; i++) {
		const r = rawRules[i]
		if (!r || typeof r !== 'object') continue // skip malformed rule
		const rr = r as Record<string, unknown>
		const match = rr['match']
		if (typeof match !== 'string' || match.length === 0) continue
		const rule: ModelQuirksRule = {
			match,
			...readString(rr, 'provider'),
			...readNumber(rr, 'temperature', 0, 2),
			...readNumber(rr, 'topP', 0, 1),
			...readIntPositive(rr, 'topK'),
			...readBool(rr, 'forceEmptyReasoning'),
			...readBool(rr, 'mirrorReasoningContent'),
			...readEnum(rr, 'forceToolCallFormat', ['native', 'xml', 'auto']),
			...readString(rr, 'note'),
		}
		rules.push(rule)
	}
	return {
		version,
		...readString(obj, 'description'),
		...readString(obj, 'docs'),
		rules,
	}
}

function readNumber(obj: Record<string, unknown>, key: string, min: number, max: number): Partial<ModelQuirksRule> {
	const v = obj[key]
	if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return {}
	return { [key]: v } as Partial<ModelQuirksRule>
}

function readIntPositive(obj: Record<string, unknown>, key: string): Partial<ModelQuirksRule> {
	const v = obj[key]
	if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) return {}
	return { [key]: v } as Partial<ModelQuirksRule>
}

function readBool(obj: Record<string, unknown>, key: string): Partial<ModelQuirksRule> {
	const v = obj[key]
	if (typeof v !== 'boolean') return {}
	return { [key]: v } as Partial<ModelQuirksRule>
}

function readEnum<T extends string>(obj: Record<string, unknown>, key: string, allowed: readonly T[]): Partial<ModelQuirksRule> {
	const v = obj[key]
	if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) return {}
	return { [key]: v as T } as Partial<ModelQuirksRule>
}

function readString(obj: Record<string, unknown>, key: string): Partial<ModelQuirksRule & ModelQuirksCatalog> {
	const v = obj[key]
	if (typeof v !== 'string' || v.length === 0) return {}
	return { [key]: v } as Partial<ModelQuirksRule & ModelQuirksCatalog>
}

/**
 * Apply user override on top of a resolved catalog match. User fields win
 * per-field — undefined in user override = catalog value preserved.
 *
 * `userOverride` is parsed from `vibeide.modelQuirks` setting, which is a free
 * JSON object — we accept it loosely (drop bad types, ignore unknown keys)
 * rather than throwing on user config typos.
 */
export function applyUserOverride(catalogQuirks: ResolvedModelQuirks, userOverride: unknown): ResolvedModelQuirks {
	if (!userOverride || typeof userOverride !== 'object') return catalogQuirks
	const oo = userOverride as Record<string, unknown>
	// Run user override through the same field-level validators as catalog rules.
	// Reuse readNumber etc. by wrapping into a fake "rule" matcher.
	const sanitized: ResolvedModelQuirks = {
		...catalogQuirks,
		...readNumber(oo, 'temperature', 0, 2),
		...readNumber(oo, 'topP', 0, 1),
		...readIntPositive(oo, 'topK'),
		...readBool(oo, 'forceEmptyReasoning'),
		...readBool(oo, 'mirrorReasoningContent'),
		...readEnum(oo, 'forceToolCallFormat', ['native', 'xml', 'auto']),
	}
	return sanitized
}
