/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `.vibe/ignore` — gitignore-subset matcher for the AGENT's file access (read / search). Pure: parses
 * the file content into ordered rules and decides whether a workspace-relative path is excluded. No
 * I/O — the service (vibeIgnoreService) owns reading/watching the file.
 *
 * Supported (a faithful subset of gitignore):
 *   • `#` comments and blank lines are skipped;
 *   • `!pattern` negation, last matching rule wins (so a later "negated debug" rule re-includes a file
 *     an earlier "all bundles" rule excluded);
 *   • leading `/` or an internal `/` anchors the pattern to the workspace root; otherwise it matches
 *     at any depth;
 *   • single-star (within a segment), `?` (one char), and double-star (across segments) globs;
 *   • a trailing `/` (directory pattern) is accepted — its descendants are matched by the same rule.
 *
 * Simplification vs. real gitignore: a trailing-`/` pattern also matches a regular file of that exact
 * name (we only ever test FILE paths for read-gating, so this is harmless in practice).
 */

export interface IgnoreRule {
	readonly negate: boolean;
	/** Original pattern body (post `!`/`/` stripping), kept for diagnostics. */
	readonly source: string;
	readonly re: RegExp;
}

const escapeRe = (c: string): string => /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c;

/** Translate one gitignore pattern body (no leading `!`, no trailing `/`) into a RegExp. */
function patternToRegExp(pattern: string, anchored: boolean): RegExp {
	let out = '';
	for (let i = 0; i < pattern.length;) {
		const c = pattern[i];
		if (c === '*') {
			if (pattern[i + 1] === '*') {
				if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 3; }   // `**/` → any number of dirs (incl. zero)
				else { out += '.*'; i += 2; }                                // `**`  → anything, crossing `/`
			} else { out += '[^/]*'; i += 1; }                               // `*`   → anything within one segment
		} else if (c === '?') { out += '[^/]'; i += 1; }                     // `?`   → one char within a segment
		else { out += escapeRe(c); i += 1; }
	}
	const prefix = anchored ? '^' : '(?:^|.*/)';
	// `(?:/.*)?$` so ignoring `dir` (or `dir/`) also ignores everything under it.
	return new RegExp(prefix + out + '(?:/.*)?$');
}

/** Parse `.vibe/ignore` content into ordered rules (order matters — last match wins). */
export function parseIgnore(content: string): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	for (const raw of content.split(/\r?\n/)) {
		let line = raw.replace(/^\s+/, '');                  // leading whitespace is not significant
		if (line === '' || line.startsWith('#')) { continue; }
		line = line.replace(/\s+$/, '');                     // trailing whitespace trimmed (no escaped-space support)
		if (line === '') { continue; }
		let negate = false;
		if (line.startsWith('!')) { negate = true; line = line.slice(1); }
		if (line.endsWith('/')) { line = line.slice(0, -1); }   // directory pattern → descendants covered by the suffix
		const hadLeadingSlash = line.startsWith('/');
		if (hadLeadingSlash) { line = line.slice(1); }
		if (line === '') { continue; }
		const anchored = hadLeadingSlash || line.includes('/');
		rules.push({ negate, source: line, re: patternToRegExp(line, anchored) });
	}
	return rules;
}

export interface IgnoreMatcher {
	/** True when `relPath` (workspace-relative, either slash style) is excluded by the rules. */
	isIgnored(relPath: string): boolean;
	readonly ruleCount: number;
}

export function createIgnoreMatcher(content: string): IgnoreMatcher {
	const rules = parseIgnore(content);
	return {
		ruleCount: rules.length,
		isIgnored(relPath: string): boolean {
			const p = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
			if (p === '') { return false; }
			let ignored = false;
			for (const r of rules) {
				if (r.re.test(p)) { ignored = !r.negate; }   // last matching rule wins
			}
			return ignored;
		},
	};
}
