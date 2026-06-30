/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure XML tool-call normalization helpers (extracted from extractGrammar.ts
 * in v0.13.10 hotfix so they can be tested in isolation).
 *
 * Three production callers in `electron-main/llmMessage/extractGrammar.ts`:
 *   - `normalizeAlternativeToolSyntax(text)` — convert vendor-specific tool-call
 *     formats into canonical `<tool><param>v</param></tool>` block form. Called
 *     on every streamed chunk + on final-message.
 *   - `stripUnclaimedToolTags(text)` — last-resort UX safety net for raw XML
 *     that escaped the parser (placeholder substitution).
 *   - `SELF_CLOSING_PARTIAL_RE` — partial-tag detector for streaming buffer.
 *
 * Tested from `test/common/xmlToolNormalize.test.ts` against every known
 * vendor format we've seen models emit (canonical, Anthropic `<invoke>`,
 * self-closing `<tool attr="v" />`, DSML fullwidth-pipe wrapper).
 *
 * **Layer constraint:** this file MUST stay pure (string → string only).
 * No node/electron imports, no IO, no side effects — that's what makes it
 * testable from `test/common/`.
 */

import { localize } from '../../../../nls.js';
import { builtinToolNames } from './prompt/prompts.js';
import { PARAM_ALIASES_BY_TOOL, TOOL_NAME_ALIASES } from './prompt/toolAliases.js';

/**
 * Separator/case-insensitive tool-name key. Collapses `FileRead`, `file_read`,
 * `fileRead`, `File-Read`, `READFILE` → `fileread` so a SINGLE concept mapping
 * covers every spelling a model invents. We map concepts (~15), never spellings.
 */
const normToolKey = (name: string): string => name.toLowerCase().replace(/[_\-\s]+/g, '');

/**
 * normKey → canonical tool name, built once from canonical names + aliases.
 * Aliases are inserted first so a canonical name (added last) always wins on a
 * normKey collision — the registered tool is authoritative.
 */
const NORMALIZED_TOOL_NAME_MAP: { readonly [normKey: string]: string } = (() => {
	const m: { [k: string]: string } = {};
	for (const [alias, target] of Object.entries(TOOL_NAME_ALIASES)) { m[normToolKey(alias)] = target; }
	for (const name of builtinToolNames) { m[normToolKey(name)] = name; }
	return m;
})();

/**
 * Resolve a raw tag name to a canonical VibeIDE tool, or `null` if it isn't one.
 *
 * Order: exact alias → exact canonical → separator/case-insensitive normKey. The
 * normKey stage is what kills the spelling whack-a-mole — `<FileRead/>`,
 * `<file_read/>`, `<ReadFile/>`, `<readFile/>` all resolve to `read_file` with
 * ZERO per-spelling entries. Returns null for non-tool tags (`<br/>`, `<Input/>`)
 * so callers can leave them untouched.
 */
export const resolveToolNameLoose = (rawName: string): string | null => {
	const lower = rawName.toLowerCase();
	if (TOOL_NAME_ALIASES[lower]) { return TOOL_NAME_ALIASES[lower]; }
	if ((builtinToolNames as readonly string[]).includes(lower)) { return lower; }
	return NORMALIZED_TOOL_NAME_MAP[normToolKey(rawName)] ?? null;
};

/**
 * Resolve an open-tag name to canonical VibeIDE tool. Case/separator-insensitive.
 * Falls back to the lowercased raw name when nothing resolves (callers that need
 * the «is this a tool at all?» signal should use `resolveToolNameLoose`).
 */
export const resolveInvokeToolName = (rawName: string): string => {
	return resolveToolNameLoose(rawName) ?? rawName.toLowerCase();
};

/**
 * Resolve a param name inside `<arg name="Y">` / `<parameter name="Y">` to
 * its canonical form for the given tool.
 */
export const resolveInvokeParamName = (rawParamName: string, canonicalToolName: string): string => {
	const lower = rawParamName.toLowerCase();
	const paramAliasMap = PARAM_ALIASES_BY_TOOL[canonicalToolName] ?? {};
	return paramAliasMap[lower] ?? lower;
};

// ── JSON-array tool-call form (X.16) ────────────────────────────────────────────
//
// Weak models and OpenAI-style function calls rendered as TEXT instead of the native channel or
// the XML grammar:
//   [{"name":"read_file","arguments":{"uri":"/foo.ts"}}]
//   [{"type":"tool","tool":"read_file","args":{…}}]
// Converted to canonical block form `<tool><param>v</param></tool>` reusing the SAME tool/param
// resolvers as the XML paths (no guessed mapping). CONSERVATIVE: an array is converted only when
// EVERY object resolves to a real tool — otherwise it is left byte-for-byte untouched (it may be
// ordinary JSON content; we never mis-route). String `arguments` (OpenAI encodes them as a JSON
// string) are parsed; object/array param values are JSON-stringified.
//
// NOT mapped here: the namespaced `{"tool":"fs","command":"read"}` form (nemotron-nano, roadmap) —
// `fs` is not a canonical tool and the command→tool + args→param map is unverified, so such entries
// fail resolveToolNameLoose and are left untouched until a verbatim sample confirms the mapping.
// See docs/knowledge/runtime-quirks/xml-tool-format-incidents.md.

/** Find the next `[` at/after `from` that is immediately followed (modulo whitespace) by `{`. */
const findArrayOfObjectsStart = (text: string, from: number): number => {
	let idx = text.indexOf('[', from);
	while (idx !== -1) {
		let j = idx + 1;
		while (j < text.length && /\s/.test(text[j])) { j++; }
		if (text[j] === '{') { return idx; }
		idx = text.indexOf('[', idx + 1);
	}
	return -1;
};

/** Given `start` at a `[`, return the index just past the matching `]` (string-aware), or -1. */
const scanBalancedArray = (text: string, start: number): number => {
	let depth = 0;
	let inStr = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			if (c === '\\') { i++; continue; }
			if (c === '"') { inStr = false; }
			continue;
		}
		if (c === '"') { inStr = true; continue; }
		if (c === '[' || c === '{') { depth++; }
		else if (c === ']' || c === '}') {
			depth--;
			if (depth === 0) { return i + 1; }
		}
	}
	return -1;
};

/** Parse one `[{…}]` span; return canonical XML blocks, or null if it is not a resolvable tool array. */
const tryConvertJsonToolSpan = (span: string): string | null => {
	let parsed: unknown;
	try { parsed = JSON.parse(span); } catch { return null; }
	if (!Array.isArray(parsed) || parsed.length === 0) { return null; }
	const blocks: string[] = [];
	for (const el of parsed) {
		if (!el || typeof el !== 'object' || Array.isArray(el)) { return null; }
		const o = el as Record<string, unknown>;
		const fn = (o.function && typeof o.function === 'object') ? o.function as Record<string, unknown> : undefined;
		const rawName = o.name ?? o.tool ?? fn?.name;
		if (typeof rawName !== 'string') { return null; }
		const canonical = resolveToolNameLoose(rawName);
		if (!canonical) { return null; } // conservative: any unresolvable entry → leave the whole array
		let args: unknown = o.args ?? o.arguments ?? o.parameters ?? fn?.arguments;
		if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = undefined; } }
		const parts: string[] = [];
		if (args && typeof args === 'object' && !Array.isArray(args)) {
			for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
				const p = resolveInvokeParamName(k, canonical);
				const val = (v === null || v === undefined) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
				parts.push(`<${p}>${val}</${p}>`);
			}
		}
		blocks.push(`<${canonical}>${parts.join('')}</${canonical}>`);
	}
	return blocks.join('\n');
};

/** Convert every confidently-resolvable `[{…tool…}]` span in `text` to canonical XML; leave the rest. */
export const convertJsonToolArrayToCanonical = (text: string): string => {
	if (!text || text.indexOf('[') === -1) { return text; }
	let out = '';
	let i = 0;
	while (i < text.length) {
		const start = findArrayOfObjectsStart(text, i);
		if (start === -1) { out += text.slice(i); break; }
		const end = scanBalancedArray(text, start);
		if (end === -1) { out += text.slice(i); break; }
		const converted = tryConvertJsonToolSpan(text.slice(start, end));
		if (converted === null) {
			// Not a tool array — keep verbatim, advance past this `[` so we can still find later ones.
			out += text.slice(i, start + 1);
			i = start + 1;
		} else {
			out += text.slice(i, start) + converted;
			i = end;
		}
	}
	return out;
};

/**
 * Vendor-specific bare wrapper names that envelope `<invoke>` blocks.
 *
 * Adding a new vendor: just append the name here. STRIP_WRAPPERS_RE and the
 * fast-path substring sniff list both derive from this array — single source
 * of truth eliminates the maintenance hazard of keeping them in sync.
 *
 * Origins:
 *   - tool_code       Gemini
 *   - function_calls  Anthropic (older)
 *   - tool_calls      DeepSeek / Anthropic (newer)
 *   - tool_use        Anthropic
 *   - tools           Generic
 */
/**
 * Vendor wrapper names — exported so streaming-state code in `extractGrammar.ts`
 * can derive its `ALT_PARTIAL_REGEXES` partial-detection patterns from the same
 * source (avoids the hardcoded `/<invoke\b[^>]*$/i` style that loses sync when
 * a new wrapper joins this list).
 */
export const VENDOR_WRAPPER_NAMES: readonly string[] = [
	'tool_code',
	'function_calls',
	'tool_calls',
	'tool_use',
	'tools',
];

/**
 * Namespaced suffix patterns: `<vendor:tool_call>`, `<minimax:invoke>`, etc.
 * Each entry is the part AFTER the colon. Vendor prefix is `[a-z][\w-]*`.
 * Exported for the same reason as `VENDOR_WRAPPER_NAMES`.
 */
export const VENDOR_NAMESPACED_SUFFIXES: readonly string[] = [
	'tool_call',
	'tool_calls',
	'tool_use',
	'function_call',
	'function_calls',
	'invoke',
	'tools',
];

/**
 * Strip wrapper tags that envelope the actual `<invoke>` block in some vendor
 * formats. Includes the bare `<tool_code>` / `<tool_calls>` / `<function_calls>`
 * wraps and the namespaced `<vendor:tool_call>` form.
 *
 * **Tolerant close (v0.13.11):** trailing `>` is OPTIONAL. Real-world observed
 * deepseek-v4-pro output omits `>` on wrapper tags:
 *   `<tool_calls<invoke name="...">…</invoke</tool_calls`
 * Pre-v0.13.11 the strict `\s*>` requirement made these orphan wrappers leak
 * into chat verbatim. The relaxed pattern matches `<wrapper>`, `</wrapper>`,
 * `<wrapper<nextOpenTag` (direct adjacency to next tag), and `<wrapper$` (at
 * end of text). Lookahead `(?=>|<|$)` keeps it conservative — won't gobble
 * arbitrary text after the wrapper name.
 *
 * Built from `VENDOR_WRAPPER_NAMES` + `VENDOR_NAMESPACED_SUFFIXES` const arrays
 * (v0.13.11 audit pass) — adding a new wrapper name to either array updates
 * both this regex AND the fast-path substring sniffs in lockstep.
 */
export const STRIP_WRAPPERS_RE = new RegExp(
	`<\\/?(?:${VENDOR_WRAPPER_NAMES.join('|')}|[a-z][\\w-]*:(?:${VENDOR_NAMESPACED_SUFFIXES.join('|')}))\\b\\s*(?:>|(?=<|$))`,
	'gi',
);

/**
 * Fast-path substring sniffs — if NONE of these markers are present in `text`,
 * `normalizeAlternativeToolSyntax` short-circuits and returns input unchanged.
 *
 * Derived from `VENDOR_WRAPPER_NAMES` + `VENDOR_NAMESPACED_SUFFIXES` + a couple
 * of constants (`<invoke`, `/>`, `｜`). **Audit-pass fix (2026-05-23):** before
 * extraction, these sniffs were hardcoded inline in `normalizeAlternativeToolSyntax`,
 * mirroring `STRIP_WRAPPERS_RE` content. Adding a new wrapper to STRIP_WRAPPERS_RE
 * without updating the sniff list would silently disable the wrapper detection
 * for that vendor. Now both come from the same const arrays.
 */
const FAST_PATH_SNIFFS: readonly string[] = [
	'<invoke',
	...VENDOR_WRAPPER_NAMES.map(name => `<${name}`),
	...VENDOR_NAMESPACED_SUFFIXES.map(suffix => `:${suffix}`),
	// Close-tag of any canonical tool → enter the full path so the paired-attribute
	// handler (`<read_file path="x">…</read_file>`, 0.13.19) gets a chance. Block-form
	// canonical tags also trigger this (harmless — normalize leaves them unchanged).
	...builtinToolNames.map(name => `</${name}`),
	'/>',           // self-closing tool tag (v0.13.10)
	'｜',          // U+FF5C — DSML fullwidth-pipe wrapper (v0.13.10)
	// JSON-array tool-call form (X.16) — enter the full path so convertJsonToolArrayToCanonical
	// runs. The converter no-ops on non-tool JSON, so these broad-ish markers are safe.
	'"arguments"',
	'"type":"tool"',
	'"type": "tool"',
];

/**
 * DSML-style fullwidth-pipe markers (v0.13.10).
 *
 * Chinese-ecosystem models (Qwen variants, deepseek-v4-pro via certain
 * aggregators) wrap tool calls with fullwidth-pipe DSML markers:
 *   `<｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke name="X"> …`
 *
 * `｜` is U+FF5C (FULLWIDTH VERTICAL LINE), NOT ASCII `|`.
 *
 * Strip pattern: pipe(s) + ASCII identifier + pipe(s). Structural, no
 * hardcoded "DSML" literal — works for `｜｜FOO｜｜`, `｜BAR｜`, `|BAZ|`.
 * After stripping, downstream regexes see canonical `<invoke>` / `<parameter>`.
 */
// X.15.6 — Unicode identifier coverage. Chinese DSML observed with ASCII
// keyword "DSML", but cousin formats may use non-ASCII ids inside the pipes.
// `\p{L}` covers any Unicode letter; the `u` flag enables it.
export const DSML_MARKER_STRIP_RE = /[｜|]{1,4}[\p{L}][\p{L}\p{N}_-]*[｜|]{1,4}/gu;

/**
 * Escape regex metacharacters in tool-name literals before joining them into
 * an alternation. Defense in depth — current canonical names and aliases are
 * all `[a-z_]+` (no special chars), but a future addition like `foo.bar` or
 * `tool+v2` would silently break the alternation without escaping. Cheap.
 */
function escapeRegexLiteral(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Self-closing tool-call regex (v0.13.10; broadened 0.13.19).
 *
 * Matches ANY attribute-style self-closing tag `<Name attr="v" ... />` where
 * `Name` is an identifier. We deliberately do NOT restrict the alternation to
 * known tool names anymore — models invent endless spellings (`<file_read/>`,
 * `<FileRead/>`, `<ReadFile/>`, …) and listing each is whack-a-mole. Instead the
 * REWRITE callback calls `resolveToolNameLoose(name)`: a real tool → normalize +
 * execute; anything else (`<br/>`, `<img/>`, a JSX `<Input/>` discussed in chat)
 * → `null` → left byte-for-byte untouched. Safety moves from the matcher to the
 * resolver, which is separator/case-insensitive and concept-mapped.
 *
 * `[^>]*?` (lazy, no `>`) keeps each match within a single tag. `escapeRegexLiteral`
 * is retained for the param-name path; the tag-name class needs no escaping.
 */
export const SELF_CLOSING_TOOL_RE = /<([A-Za-z][A-Za-z0-9_-]*)\s+([^>]*?)\s*\/>/g;

/**
 * Partial detection for self-closing tool tag mid-stream (v0.13.10).
 *
 * `<read_file path="d:\Project` — no `/>` yet, but clearly a tool call in
 * progress. Without this, raw XML would flicker on screen between chunks.
 * Same name-universe restriction as `SELF_CLOSING_TOOL_RE`.
 */
export const SELF_CLOSING_PARTIAL_RE = (() => {
	const names = [
		...builtinToolNames,
		...Object.keys(TOOL_NAME_ALIASES),
	];
	names.sort((a, b) => b.length - a.length);
	const escaped = names.map(escapeRegexLiteral);
	return new RegExp(`<(${escaped.join('|')})\\s+[^>]*$`, 'i');
})();

/**
 * Convert vendor-specific tool-call syntaxes into canonical
 * `<tool_name><param>value</param></tool_name>` block form so the regular
 * extractor (`extractXMLToolsWrapper`) handles them with one code path.
 *
 * Handles three classes:
 *   1. Anthropic `<invoke name="X"><parameter name="Y">V</parameter></invoke>`
 *      (and the same with extra attributes on `<parameter>`).
 *   2. Self-closing `<tool_name attr="v" attr2="v2" />` (deepseek-v4-pro,
 *      Kilo-trained variants).
 *   3. DSML fullwidth-pipe wrapper `<｜｜DSML｜｜invoke …>` (Qwen et al.).
 *
 * Canonical block form `<read_file><path>v</path></read_file>` is left alone
 * (the regex requires `\s+` after the tag name; canonical has `>` immediately).
 *
 * @param text — accumulated buffer from a streaming response.
 * @returns text with all vendor formats rewritten to canonical block form.
 */
export const normalizeAlternativeToolSyntax = (text: string): string => {
	// Defensive guard: TS types say `string` but runtime may pass undefined
	// (e.g. an upstream optional-chained field that resolved nullish). Pre-fix
	// `text.includes(...)` would throw TypeError. Cheap.
	if (!text) { return text; }
	// Fast path: no alternative-syntax markers present at all. Loop terminates
	// at the first hit — for clean prose without any tool markers (the common
	// case) we do at most ~16 substring scans before bailing.
	let needsFullPath = false;
	for (const sniff of FAST_PATH_SNIFFS) {
		if (text.includes(sniff)) { needsFullPath = true; break; }
	}
	if (!needsFullPath) { return text; }
	// X.4 — telemetry counter on full-path entry. Lets us see at-a-glance
	// how often normalization is needed vs the fast-path bypass (signal for
	// whether the pipeline carries weight or is mostly idle infrastructure).
	bumpCounter('fullPath');
	// X.16 — JSON-array tool form FIRST: convert `[{"name":"tool","arguments":{…}}]` to canonical
	// XML so the downstream XML transforms + L2 extractor handle it uniformly. Conservative converter
	// leaves non-tool JSON untouched. Runs before DSML/wrapper strips (JSON carries no XML markers).
	const beforeJson = text;
	const jsonNormalized = convertJsonToolArrayToCanonical(text);
	if (jsonNormalized !== beforeJson) { bumpCounter('jsonArray'); }
	// Strip DSML fullwidth-pipe markers FIRST so the downstream regexes (which
	// look for literal `<invoke`, `<parameter`, etc.) see canonical tag names.
	let beforeDsml = jsonNormalized;
	let result = jsonNormalized.replace(DSML_MARKER_STRIP_RE, '');
	if (result !== beforeDsml) { bumpCounter('dsml'); }
	beforeDsml = result;
	result = result.replace(STRIP_WRAPPERS_RE, '');
	if (result !== beforeDsml) { bumpCounter('wrapper'); }
	// X.13.5 — self-closing invoke combo `<invoke name="X" attr="v" />`.
	// Combines attribute-style open with self-close. Not yet observed in
	// production but conceptually plausible — covered defensively.
	const beforeSelfClosingInvoke = result;
	result = result.replace(
		/<invoke\s+name=["']([^"']+)["']([^>]*?)\/>/gi,
		(_match: string, rawToolName: string, attrsStr: string) => {
			const canonical = resolveInvokeToolName(rawToolName);
			// X.15.5 / X.15.8 — Unicode param names + escaped-quote tolerance.
			const attrRe = /([\p{L}_][\p{L}\p{N}_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/gu;
			let attrMatch: RegExpExecArray | null;
			const parts: string[] = [];
			while ((attrMatch = attrRe.exec(attrsStr)) !== null) {
				const name = attrMatch[1];
				if (name === 'name') { continue; }
				const value = attrMatch[2] ?? attrMatch[3] ?? '';
				const canonicalParam = resolveInvokeParamName(name, canonical);
				parts.push(`<${canonicalParam}>${value}</${canonicalParam}>`);
			}
			return `<${canonical}>${parts.join('')}</${canonical}>`;
		}
	);
	if (result !== beforeSelfClosingInvoke) { bumpCounter('selfClosing'); }
	const beforeInvoke = result;
	result = result.replace(
		// `[^>]*` after `name="X"` tolerates additional attributes (some models
		// emit `<parameter name="filePath" string="true">` — pre-fix the trailing
		// attribute made the regex skip the match entirely).
		//
		// **Tolerant close (v0.13.11):** `</invoke\s*(?:>|(?=<|$))` matches close
		// tag with OR without the trailing `>`. Observed deepseek-v4-pro emits
		// `</invoke</tool_calls` (no `>` on either) — pre-v0.13.11 the strict
		// `</invoke>` requirement made the entire invoke block fail to match,
		// leaking raw XML verbatim into chat.
		/<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke\s*(?:>|(?=<|$))/gi,
		(_match: string, rawToolName: string, body: string) => {
			const canonical = resolveInvokeToolName(rawToolName);
			const transformedBody = body.replace(
				// Tolerant close on `</parameter>` too (v0.13.11) — same rationale as
				// invoke close: deepseek-v4-pro observed omitting `>` on chained close tags.
				/<(?:arg|parameter)\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:arg|parameter)\s*(?:>|(?=<|$))/gi,
				(_m: string, rawParamName: string, value: string) => {
					const canonicalParam = resolveInvokeParamName(rawParamName, canonical);
					return `<${canonicalParam}>${value}</${canonicalParam}>`;
				}
			);
			return `<${canonical}>${transformedBody}</${canonical}>`;
		}
	);
	if (result !== beforeInvoke) { bumpCounter('invoke'); }
	// Paired attribute-style tag: `<read_file path="x"> </read_file>` — params as
	// attributes on a paired open/close tag (deepseek-v4-pro, 0.13.19). Neither the
	// self-closing handler (needs `/>`) nor the block extractor (wants child param
	// tags) catches it. Convert attrs → child param tags; keep body only if it
	// already carries child tags (drop stray text/whitespace). Loose-resolve + bail
	// leaves `<div class="x">…</div>` and other non-tool paired tags untouched.
	const beforePairedAttr = result;
	result = result.replace(
		/<([A-Za-z][A-Za-z0-9_-]*)\s+([^>]*?=[^>]*?)>([\s\S]*?)<\/\1\s*(?:>|(?=<|$))/g,
		(_m: string, rawTool: string, attrsStr: string, body: string) => {
			const canonical = resolveToolNameLoose(rawTool);
			if (!canonical) { return _m; }
			const attrRe = /([\p{L}_][\p{L}\p{N}_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/gu;
			let am: RegExpExecArray | null;
			const parts: string[] = [];
			while ((am = attrRe.exec(attrsStr)) !== null) {
				const cp = resolveInvokeParamName(am[1], canonical);
				parts.push(`<${cp}>${am[2] ?? am[3] ?? ''}</${cp}>`);
			}
			const keptBody = body && body.includes('<') ? body : '';
			return `<${canonical}>${parts.join('')}${keptBody}</${canonical}>`;
		}
	);
	if (result !== beforePairedAttr) { bumpCounter('pairedAttr'); }
	if (result.includes('/>')) {
		const beforeSelfClosing = result;
		result = result.replace(SELF_CLOSING_TOOL_RE, (_match: string, rawTool: string, attrsStr: string) => {
			// Broadened regex matches ANY `<Name attr="v"/>`; bail unless the name
			// resolves to a real tool — leaves `<br/>`, `<img/>`, JSX `<Input/>` etc.
			// byte-for-byte untouched. This is the safety gate (matcher is now loose).
			const canonical = resolveToolNameLoose(rawTool);
			if (!canonical) { return _match; }
			// X.15.5 — Unicode param-name support via `\p{L}` (e.g. `путь`,
			// `路径`). X.15.8 — escaped-quote tolerance: `"((?:[^"\\]|\\.)*)"`
			// captures attribute values containing `\"` escapes.
			const attrRe = /([\p{L}_][\p{L}\p{N}_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/gu;
			let attrMatch: RegExpExecArray | null;
			const parts: string[] = [];
			while ((attrMatch = attrRe.exec(attrsStr)) !== null) {
				const name = attrMatch[1];
				const value = attrMatch[2] ?? attrMatch[3] ?? '';
				const canonicalParam = resolveInvokeParamName(name, canonical);
				parts.push(`<${canonicalParam}>${value}</${canonicalParam}>`);
			}
			return `<${canonical}>${parts.join('')}</${canonical}>`;
		});
		if (result !== beforeSelfClosing) { bumpCounter('selfClosing'); }
	}
	return result;
};

// X.4 — local hit counters for normalization formats. Read via
// `getNormalizeCounters()` and reset via `resetNormalizeCounters()`. The
// browser-side telemetry harvester (W.39) periodically samples + reports
// via `IMetricsService.capture('vibeide.xmlNormalize.hit', counts)`.
//
// Lives in common because the producer (transforms above) is common-layer
// pure code; the consumer can be wired from any process.
type NormalizeCounterKey = 'fullPath' | 'dsml' | 'wrapper' | 'invoke' | 'pairedAttr' | 'selfClosing' | 'jsonArray' | 'safetyNetPaired' | 'safetyNetSelfClosing' | 'safetyNetVendor';
const normalizeCounters: Record<NormalizeCounterKey, number> = {
	fullPath: 0,
	dsml: 0,
	wrapper: 0,
	invoke: 0,
	pairedAttr: 0,
	selfClosing: 0,
	jsonArray: 0,
	safetyNetPaired: 0,
	safetyNetSelfClosing: 0,
	safetyNetVendor: 0,
};
function bumpCounter(key: NormalizeCounterKey): void {
	normalizeCounters[key] += 1;
}
export const getNormalizeCounters = (): Readonly<Record<NormalizeCounterKey, number>> => ({ ...normalizeCounters });
export const resetNormalizeCounters = (): void => {
	for (const k of Object.keys(normalizeCounters) as NormalizeCounterKey[]) { normalizeCounters[k] = 0; }
};

/**
 * UX safety-net placeholder for raw XML that escaped the canonical parser.
 *
 * **Localized (v0.13.11 audit pass):** previously hardcoded English. Russian
 * users now see Russian text. `localize()` is lazy: the placeholder string is
 * resolved on each call, after the NLS bundle has loaded. Acceptable cost
 * given this hot-path runs at most once per tool-tag occurrence per render.
 */
export const unclaimedToolTagPlaceholder = (): string =>
	'\n*' + localize('vibeide.xml.unclaimedToolTag', '[вызов инструмента — некорректный формат от модели, скрыто]') + '*\n';

/**
 * Pre-compiled regex pair per canonical tool name (v0.13.11 audit pass).
 *
 * Before extraction, `stripUnclaimedToolTags` built two new `RegExp` objects
 * per tool per call (2 × N regex allocations on every streaming tick). For
 * N ≈ 25 tools at 10 ticks/sec that's 500 RegExp allocations/sec.
 *
 * Now each regex pair is built **once** at module init. The strip loop just
 * iterates the precomputed array.
 */
interface StripPattern { readonly paired: RegExp; readonly selfClosing: RegExp }
const STRIP_PATTERNS: readonly StripPattern[] = builtinToolNames.map(toolName => {
	// Defense in depth: escape regex metacharacters in the tool name. Current
	// canonical names are all `[a-z_]+` (no special chars), but a future
	// addition like `foo.bar` would silently produce broken regex without escape.
	const escaped = escapeRegexLiteral(toolName);
	return {
		// Open tag tolerates attributes (`<read_file path="x">…</read_file>` —
		// deepseek-v4-pro paired-attribute form, 0.13.19) AND the plain `<read_file>`
		// block form. Tolerant close (whitespace before `>`).
		paired: new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}\\s*>`, 'g'),
		// Self-closing form with tolerant close (v0.13.11): `<tag attrs />` AND
		// `<tag attrs /` (no trailing `>`). Symmetric with the tolerant invoke/wrapper
		// closes in `normalizeAlternativeToolSyntax`.
		selfClosing: new RegExp(`<${escaped}\\s+[^>]*\\/(?:>|(?=<|$|\\s))`, 'g'),
	};
});

/**
 * Vendor tool-call leak patterns (v0.13.17). When a model emits an Anthropic-style
 * `<invoke>` / `<tool_calls>` wrapper that `normalizeAlternativeToolSyntax` couldn't
 * convert — most often because the close tag is TRUNCATED (`</inv`, `</tool_c`)
 * the way deepseek-v4-pro via openCodeGo emits it — the raw block leaks into chat.
 * `stripUnclaimedToolTags` (canonical-name based) never matched these, so they slipped
 * through. These tokens never occur in legitimate prose, so scrubbing is safe.
 *
 *   - BLOCK: from a vendor OPEN tag to the next vendor/invoke CLOSE tag (full OR
 *     truncated). Non-greedy so it stops at the first close. Covers the observed
 *     `<tool_c <invoke name="…">…</parameter> </inv` shape.
 *   - FRAGMENT: leftover standalone wrapper open/close fragments (e.g. the trailing
 *     `</tool_c` the block pass leaves behind). Wrapper tokens only — NOT `<parameter>`
 *     (those live inside the block and are consumed there; stripping them standalone
 *     risks mangling prose/code).
 *
 * Longer tokens first in each alternation so `tool_calls`/`tool_code` win before the
 * truncated `tool_c`.
 */
// Token alternation derived from `VENDOR_WRAPPER_NAMES` (single source of truth — same
// const that feeds `STRIP_WRAPPERS_RE`/`FAST_PATH_SNIFFS`) plus `invoke` and a small
// EMPIRICAL set of truncated variants the way deepseek-v4-pro via openCodeGo emits them
// (`<tool_c`/`</inv` cut mid-tag). Adding a vendor wrapper to VENDOR_WRAPPER_NAMES extends
// these scrubs automatically — no duplicated hardcoded list. Longest-first so full names
// win over their truncated prefixes.
const VENDOR_LEAK_TRUNCATIONS: readonly string[] = ['tool_c', 'inv'];
const vendorLeakAlternation = [...VENDOR_WRAPPER_NAMES, 'invoke', ...VENDOR_LEAK_TRUNCATIONS]
	.slice()
	.sort((a, b) => b.length - a.length)
	.map(escapeRegexLiteral)
	.join('|');
// Trailing `(?:[^>]*>)?` (NOT `[^>]*>?`): for a TRUNCATED close with no `>` (e.g. `</inv `
// before `</tool_c`), a bare `[^>]*` would greedily swallow the following prose up to the
// next `>`/EOL. The grouped form only consumes `attrs>` when a `>` actually closes the tag.
const VENDOR_LEAK_BLOCK_RE = new RegExp(`<(?:${vendorLeakAlternation})\\b[\\s\\S]*?<\\/(?:${vendorLeakAlternation})\\b(?:[^>]*>)?`, 'gi');
const VENDOR_LEAK_FRAGMENT_RE = new RegExp(`<\\/?(?:${vendorLeakAlternation})\\b(?:[^>]*>)?`, 'gi');

/**
 * Last-resort scrub. If a tool tag in canonical form OR self-closing form
 * makes it through `extractXMLToolsWrapper` (e.g. parser only processes the
 * first call per turn, subsequent calls in the same response would leak raw),
 * substitute it with a polite italic placeholder so the user doesn't see raw
 * XML clutter.
 *
 * Restricted to canonical builtin names — aliases like `<read>` (a common
 * English word) are NOT stripped to avoid mangling regular prose.
 */
export const stripUnclaimedToolTags = (text: string): string => {
	if (!text || text.indexOf('<') === -1) { return text; }
	let out = text;
	let placeholder: string | null = null;
	// Vendor-wrapper leaks first (Anthropic <invoke>, <tool_calls>, truncated
	// <tool_c/</inv) — these escape the canonical-name passes below. The block pass
	// replaces a full malformed region with one placeholder; the fragment pass (run
	// independently — a lone unclosed `<invoke …>` has no block to match) clears any
	// leftover standalone wrapper open/close tokens with no extra placeholders.
	let didVendorScrub = false;
	if (VENDOR_LEAK_BLOCK_RE.test(out)) {
		placeholder ??= unclaimedToolTagPlaceholder();
		out = out.replace(VENDOR_LEAK_BLOCK_RE, placeholder);
		didVendorScrub = true;
	}
	if (VENDOR_LEAK_FRAGMENT_RE.test(out)) {
		out = out.replace(VENDOR_LEAK_FRAGMENT_RE, '');
		didVendorScrub = true;
	}
	if (didVendorScrub) { bumpCounter('safetyNetVendor'); }
	for (const { paired, selfClosing } of STRIP_PATTERNS) {
		if (paired.test(out)) {
			placeholder ??= unclaimedToolTagPlaceholder();
			out = out.replace(paired, placeholder);
			bumpCounter('safetyNetPaired');
		}
		if (selfClosing.test(out)) {
			placeholder ??= unclaimedToolTagPlaceholder();
			out = out.replace(selfClosing, placeholder);
			bumpCounter('safetyNetSelfClosing');
		}
	}
	return out;
};
