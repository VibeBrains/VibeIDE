/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Best-effort recovery of malformed JSON that LLMs emit for tool-call arguments
 * (roadmap 1708). Strictly a FALLBACK: callers try `JSON.parse` first and only
 * reach here on failure; this returns `undefined` when it still cannot produce
 * valid JSON, so it can NEVER make a currently-parsing input worse — the worst
 * case is the caller's existing `{}` default.
 *
 * Handles the breakages actually seen from aggregator-proxied models:
 *   - trailing commas before `}` / `]`
 *   - trailing prose/garbage after the top-level value (`{...} here you go`)
 *   - leading prose before the value (`Sure: {...}`)
 *   - truncation: an unterminated string and/or unclosed brackets from a cut
 *     stream or max_tokens — closed up to a parseable prefix.
 *
 * Deliberately STRING-AWARE: it tracks quote/escape state so it never mutates
 * the inside of a quoted value (a string containing `,}` or `"` is untouched).
 * It does NOT attempt single-quote → double-quote or unquoted-key fixes — those
 * are too easy to corrupt, so such inputs fall through to `undefined`.
 */

export function lenientJsonParse(input: unknown): unknown | undefined {
	if (typeof input !== 'string') { return undefined; }
	try { return JSON.parse(input); } catch { /* fall through to repair */ }
	const repaired = repairJson(input);
	if (repaired === undefined) { return undefined; }
	try { return JSON.parse(repaired); } catch { return undefined; }
}

/**
 * Convenience wrapper for the common case (tool-call arguments are always a JSON
 * object): returns the parsed value only when it is a plain object, else undefined.
 */
export function lenientJsonParseObject(input: unknown): { [k: string]: unknown } | undefined {
	const v = lenientJsonParse(input);
	return (v && typeof v === 'object' && !Array.isArray(v)) ? v as { [k: string]: unknown } : undefined;
}

/**
 * Produce a repaired JSON string from a malformed one, or `undefined` if no
 * structural object/array could be recovered. Only top-level `{` / `[` values
 * are recovered (tool arguments are always objects).
 */
export function repairJson(input: string): string | undefined {
	const s = input;
	let out = '';
	const closers: string[] = []; // expected close chars, in open order ('}' / ']')
	let inString = false;
	let escaped = false;
	let started = false;

	for (let i = 0; i < s.length; i++) {
		const ch = s[i];

		if (inString) {
			out += ch;
			if (escaped) { escaped = false; }
			else if (ch === '\\') { escaped = true; }
			else if (ch === '"') { inString = false; }
			continue;
		}

		// Outside a string.
		if (!started) {
			// Skip any leading prose/whitespace until the value actually begins.
			if (ch === '{' || ch === '[') {
				started = true;
				closers.push(ch === '{' ? '}' : ']');
				out += ch;
			}
			continue;
		}

		if (ch === '"') { inString = true; out += ch; continue; }
		if (ch === '{') { closers.push('}'); out += ch; continue; }
		if (ch === '[') { closers.push(']'); out += ch; continue; }
		if (ch === '}' || ch === ']') {
			out = dropTrailingComma(out);
			out += ch;
			closers.pop();
			if (closers.length === 0) {
				// Top-level value closed — ignore any trailing garbage after it.
				return out;
			}
			continue;
		}
		out += ch;
	}

	if (!started) { return undefined; }

	// Reached end mid-value (truncation). Close an open string, drop a dangling
	// trailing comma, then close any still-open brackets in LIFO order.
	if (inString) { out += '"'; }
	out = dropTrailingComma(out);
	for (let i = closers.length - 1; i >= 0; i--) { out += closers[i]; }
	return out;
}

/**
 * Remove a single trailing comma (and surrounding trailing whitespace) from the
 * structural output. Safe to call only with `out` that is NOT inside a string —
 * the scanner guarantees that at every call site.
 */
function dropTrailingComma(out: string): string {
	const trimmed = out.replace(/\s+$/, '');
	if (trimmed.endsWith(',')) { return trimmed.slice(0, -1); }
	return out;
}
