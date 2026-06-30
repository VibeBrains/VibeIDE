/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `qps-ploc` pseudo-locale transformer (pure helper)
 * (roadmap §"i18n improvements — Pseudo-locale `qps-ploc`: запуск
 * `code.bat --locale qps-ploc` рендерит строки как `[!!_eXampLe_!!]` —
 * мгновенный визуальный QA непокрытых мест без затрат на перевод").
 *
 * Pure helper — `vscode`-free. VS Code already supports `qps-ploc` via
 * the standard NLS layer; this module:
 *   - produces the same transform offline so unit tests can assert
 *     "this string is qps-ploc style"
 *   - validates that a rendered UI sample looks pseudo-localised (the
 *     e2e smoke from line 505 calls this)
 *   - exposes `looksPseudoLocalised` for snapshot assertions
 *
 * Transform contract (matches VS Code's qps-ploc):
 *   1. wrap with `[` + `!!_` ... `_!!` + `]`
 *   2. alternate-case the inner letters (`e`,`X`,`a`,`M`,`p`,`L`,`e`)
 *   3. preserve `{0}`/`{1}` placeholders verbatim
 *   4. preserve leading/trailing whitespace
 */

const PLACEHOLDER_RE = /\{\d+\}/g;
const PRESERVE_TOKEN_PATTERN = /(\{\d+\}|\$\{[^}]+\}|<[^>]+>)/g;

export interface PseudoLocaleOptions {
	readonly preservePlaceholders?: boolean;
	readonly addBrackets?: boolean;
}

/**
 * Transform an English source string into the qps-ploc pseudo-locale
 * style. Pure — deterministic.
 */
export function pseudoLocalise(source: string, options: PseudoLocaleOptions = {}): string {
	if (typeof source !== 'string') { return ''; }
	if (source.length === 0) { return source; }
	const preservePlaceholders = options.preservePlaceholders !== false;
	const addBrackets = options.addBrackets !== false;

	const leadingWs = source.match(/^\s*/)?.[0] ?? '';
	const trailingWs = source.match(/\s*$/)?.[0] ?? '';
	const core = source.slice(leadingWs.length, source.length - trailingWs.length);
	if (core.length === 0) { return source; }

	let inner: string;
	if (preservePlaceholders) {
		const tokens: { token: string; index: number }[] = [];
		let working = core;
		// Replace tokens with sentinels that bypass alternate-casing.
		working = working.replace(PRESERVE_TOKEN_PATTERN, (m, _g, offset) => {
			const idx = tokens.length;
			tokens.push({ token: m, index: idx });
			return `${idx}`;
		});
		const cased = alternateCase(working);
		// Restore tokens.
		inner = cased.replace(/(\d+)/g, (_m, idxStr) => {
			const idx = Number(idxStr);
			return tokens[idx].token;
		});
	} else {
		inner = alternateCase(core);
	}

	const wrapped = addBrackets ? `[!!_${inner}_!!]` : inner;
	return `${leadingWs}${wrapped}${trailingWs}`;
}

function alternateCase(s: string): string {
	let upperNext = false;
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (/[a-zA-Z]/.test(ch)) {
			out += upperNext ? ch.toUpperCase() : ch.toLowerCase();
			upperNext = !upperNext;
		} else {
			out += ch;
		}
	}
	return out;
}

const PSEUDO_LOCALE_PATTERN = /^\s*\[!!_.*_!!\]\s*$/;

/**
 * Validate that a string LOOKS pseudo-localised. Used by the e2e smoke
 * test (line 505) to assert no English remnants in screenshots.
 *
 *   - empty / whitespace-only → false (cannot tell)
 *   - matches `[!!_..._!!]` envelope → true
 */
export function looksPseudoLocalised(rendered: string): boolean {
	if (typeof rendered !== 'string' || rendered.trim().length === 0) { return false; }
	return PSEUDO_LOCALE_PATTERN.test(rendered);
}

/**
 * Find non-pseudo-localised UI strings in a captured snapshot. Pure —
 * caller passes the snapshot of UI strings (label / tooltip / placeholder).
 *
 *   - excludes empty / whitespace strings (nothing to assert)
 *   - excludes pure-numeric / pure-symbolic strings ('123', '...', '/')
 *   - excludes strings that have the qps-ploc envelope (good)
 *   - returns the rest (bad — these are missing `localize()` wraps)
 */
export function findEnglishLeaksInSnapshot(strings: ReadonlyArray<string>): readonly string[] {
	const out: string[] = [];
	for (const s of strings) {
		if (typeof s !== 'string') { continue; }
		const trimmed = s.trim();
		if (trimmed.length === 0) { continue; }
		if (/^[\d\s\W]+$/.test(trimmed)) { continue; }
		if (looksPseudoLocalised(s)) { continue; }
		// Letters present but no envelope → likely English remnant.
		out.push(s);
	}
	return out;
}

/** Strip the qps-ploc envelope, returning the inner cased string. */
export function stripPseudoLocaleEnvelope(rendered: string): string | null {
	if (typeof rendered !== 'string') { return null; }
	const m = /^\s*\[!!_(.*)_!!\]\s*$/.exec(rendered);
	if (m === null) { return null; }
	return m[1];
}

/** Number of `{N}` placeholders preserved verbatim. */
export function countPlaceholdersPreserved(rendered: string): number {
	const m = rendered.match(PLACEHOLDER_RE);
	return m === null ? 0 : m.length;
}
