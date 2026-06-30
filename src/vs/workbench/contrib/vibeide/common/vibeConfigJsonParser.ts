/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure helpers for reading `.vibe/*.json` config files in a way that does NOT crash a
 * service when the file is corrupted. The default approach in services so far has been:
 *
 *   const data = JSON.parse(fileText);  // throws → service init throws → IDE breaks
 *
 * This module replaces that with an envelope-style decoder:
 *
 *   const result = safeParseConfigJson(fileText, defaults);
 *   if (!result.ok) {
 *     log.warn(`config corrupt: ${result.reason}`);
 *     showBanner(result.reason);          // never silent
 *     useDefaults();
 *   } else {
 *     useValue(result.value);
 *   }
 *
 * Closes L.4 line 1029 (`.vibe/*.json` corruption recovery). Adopting the helper
 * service-by-service is a follow-up: every existing `JSON.parse` of a `.vibe/*.json`
 * should switch to `safeParseConfigJson`, and the service should keep using `defaults`
 * until the user opens the file and re-saves a valid version.
 */

export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

/**
 * Strip JSONC-style `//` line comments and `/* … *\/` block comments outside of string
 * literals. Same logic as in vibeSettingsMigrationContribution.ts; duplicated here so
 * the helper has zero project-internal imports.
 */
function stripJsoncComments(s: string): string {
	let out = '';
	let i = 0;
	const n = s.length;
	let inString = false;
	let stringQuote: '"' | '\'' | null = null;
	while (i < n) {
		const c = s[i];
		const next = s[i + 1];
		if (inString) {
			out += c;
			if (c === '\\' && i + 1 < n) {
				out += s[++i];
				i++;
				continue;
			}
			if (c === stringQuote) {
				inString = false;
				stringQuote = null;
			}
			i++;
			continue;
		}
		if (c === '"' || c === '\'') {
			inString = true;
			stringQuote = c as '"' | '\'';
			out += c;
			i++;
			continue;
		}
		if (c === '/' && next === '/') {
			while (i < n && s[i] !== '\n') { i++; }
			continue;
		}
		if (c === '/' && next === '*') {
			i += 2;
			while (i + 1 < n && !(s[i] === '*' && s[i + 1] === '/')) { i++; }
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/**
 * Strict-envelope JSON parser: returns `{ ok: true; value }` on success or
 * `{ ok: false; reason }` on every failure mode (empty input, JSONC parse error,
 * non-object root, validator rejection). Never throws.
 *
 * Generic over `T`. Pass an optional `validator` to enforce the doc shape; without
 * one any successfully-parsed value is returned as-is (cast through `T`).
 *
 * @param raw           file contents; `undefined` and empty string are valid (empty
 *                      means "no config saved yet" — returns `{ ok:false, reason:'empty' }`
 *                      so the caller can decide between defaults and an explicit "no
 *                      file yet" path).
 * @param validator     optional function returning true iff the parsed value is shaped
 *                      as expected. Useful for `permissions.json` / `constraints.json`.
 */
export function safeParseConfigJson<T = unknown>(
	raw: string | undefined | null,
	validator?: (value: unknown) => value is T,
): ParseResult<T> {
	if (raw === undefined || raw === null) {
		return { ok: false, reason: 'empty' };
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return { ok: false, reason: 'empty' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsoncComments(raw));
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : 'unknown';
		return { ok: false, reason: `json-parse: ${message}` };
	}
	if (parsed === undefined || parsed === null) {
		return { ok: false, reason: 'null-root' };
	}
	if (validator) {
		if (!validator(parsed)) {
			return { ok: false, reason: 'validator-rejected' };
		}
		return { ok: true, value: parsed };
	}
	return { ok: true, value: parsed as T };
}

/**
 * Convenience wrapper: returns `value` on success, `defaults` on every failure.
 * The reason is reported via the optional `onFallback` callback so the caller can
 * surface a banner. The default (no callback) is silent — DO NOT use without a
 * banner / log; silent fallback violates the L.4 rule.
 */
export function parseConfigJsonOrDefaults<T>(
	raw: string | undefined | null,
	defaults: T,
	onFallback?: (reason: string) => void,
	validator?: (value: unknown) => value is T,
): T {
	const result = safeParseConfigJson<T>(raw, validator);
	if (result.ok) {
		return result.value;
	}
	if (onFallback) {
		onFallback(result.reason);
	}
	return defaults;
}
