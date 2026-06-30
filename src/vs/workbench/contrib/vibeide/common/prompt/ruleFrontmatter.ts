/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Cursor-style rule file (`.mdc`) frontmatter parsing for `.vibe/rules/` and `.cursor/rules/`
 * (roadmap R.1). `.mdc` files carry a leading YAML-ish frontmatter block:
 *
 *   ---
 *   description: When to apply this rule
 *   globs: src/**\/*.ts, *.tsx
 *   alwaysApply: true
 *   ---
 *   <rule body…>
 *
 * We strip the frontmatter from the body (the body is the instruction the model reads) and
 * expose the parsed keys so callers can later gate by `alwaysApply` / `globs`. Pure & dependency-free
 * so it unit-tests without the workspace services.
 */

import { match as globMatch } from '../../../../../base/common/glob.js';

export interface ParsedRuleFile {
	readonly frontmatter: Readonly<Record<string, string>>;
	readonly body: string;
}

// Frontmatter must be the very first content: `---` on line 1 (optional BOM/trailing spaces),
// a block, then a closing `---` line. CRLF and LF both tolerated. Non-greedy block match.
const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const KEY_VALUE_RE = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/;

export function parseRuleFrontmatter(content: string): ParsedRuleFile {
	const match = FRONTMATTER_RE.exec(content);
	if (!match) {
		return { frontmatter: {}, body: content };
	}
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = KEY_VALUE_RE.exec(line);
		if (kv) {
			frontmatter[kv[1].toLowerCase()] = kv[2].trim();
		}
	}
	return { frontmatter, body: content.slice(match[0].length) };
}

/** Recognise rule files by extension: Markdown (`.md`) and Cursor rules (`.mdc`). */
export function isRuleFileName(name: string): boolean {
	return /\.(md|mdc)$/i.test(name);
}

/** Short, typeable rule name from a path: basename without extension, lowercased.
 *  `.vibe/rules/dev-engine.mdc` → `dev-engine`. Used for `@rule:<name>` (R.5) + the index. */
export function ruleNameFromPath(relativePath: string): string {
	const base = relativePath.replace(/\\/g, '/').split('/').pop() ?? relativePath;
	return base.replace(/\.(md|mdc)$/i, '').toLowerCase();
}

/** Parse `@rule:NAME` / `/rule:NAME` invocations from the user message (deduped, lowercased). R.5. */
export function parseRuleInvocations(text: string): string[] {
	if (!text) { return []; }
	const names = new Set<string>();
	for (const m of text.matchAll(/[@/]rule:\s*([\w.-]+)/gi)) {
		names.add(m[1].toLowerCase());
	}
	return [...names];
}

/** Parse `alwaysApply: true` (case-insensitive). Absent / non-true → false. */
export function isAlwaysApply(frontmatter: Readonly<Record<string, string>>): boolean {
	return (frontmatter['alwaysapply'] ?? '').trim().toLowerCase() === 'true';
}

/**
 * Tri-state `alwaysApply`: `true` / `false` when present, `undefined` when the key is absent.
 * The distinction matters for activation: an explicit `alwaysApply: false` means
 * "conditional/agent-requested", while ABSENT means "plain rule → always inject" (back-compat).
 */
export function parseAlwaysApply(frontmatter: Readonly<Record<string, string>>): boolean | undefined {
	if (!Object.hasOwn(frontmatter, 'alwaysapply')) { return undefined; }
	return frontmatter['alwaysapply'].trim().toLowerCase() === 'true';
}

/** Split a comma-separated frontmatter list, stripping surrounding quotes/whitespace and empties. */
function splitList(value: string | undefined): string[] {
	if (!value) { return []; }
	return value
		.split(',')
		.map(s => s.trim().replace(/^["']|["']$/g, '').trim())
		.filter(s => s.length > 0);
}

/** `triggers: "deploy", "ci"` → `['deploy','ci']` (lowercased for case-insensitive matching). R.7. */
export function parseTriggers(frontmatter: Readonly<Record<string, string>>): string[] {
	return splitList(frontmatter['triggers']).map(s => s.toLowerCase());
}

/** `globs: src/**\/*.ts, *.tsx` → `['src/**\/*.ts','*.tsx']` (case preserved for path matching). R.2. */
export function parseGlobs(frontmatter: Readonly<Record<string, string>>): string[] {
	return splitList(frontmatter['globs']);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word, case-insensitive match of any trigger inside `text`. Uses Unicode letter/number
 * boundaries so Cyrillic / mixed-language triggers work (`\b` is ASCII-only).
 */
export function matchesAnyTrigger(triggers: readonly string[], text: string): boolean {
	if (!text) { return false; }
	for (const t of triggers) {
		if (!t) { continue; }

		const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t)}(?![\\p{L}\\p{N}])`, 'iu');
		if (re.test(text)) { return true; }
	}
	return false;
}

export interface RuleMeta {
	/** `true` / `false` when the key is present; `undefined` when absent (plain rule). */
	readonly alwaysApply: boolean | undefined;
	readonly triggers: readonly string[];
	readonly globs: readonly string[];
}

export type RuleActivation = 'inject' | 'index';

export interface RuleActivationContext {
	/** Latest user message — matched against `triggers` (R.7). */
	readonly userText?: string;
	/** Workspace-relative, `/`-separated file paths in context this turn — matched against `globs` (R.2). */
	readonly files?: readonly string[];
}

function basename(p: string): string {
	const i = p.lastIndexOf('/');
	return i >= 0 ? p.slice(i + 1) : p;
}

/** True if any `glob` matches any `file` (workspace-relative). A glob without `/` (e.g. `*.tsx`)
 *  also matches by basename so it fires for files at any depth (Cursor semantics). R.2. */
export function ruleGlobsMatchAnyFile(globs: readonly string[], files: readonly string[]): boolean {
	for (const g of globs) {
		if (!g) { continue; }
		const noSlash = !g.includes('/');
		for (const f of files) {
			if (!f) { continue; }
			if (globMatch(g, f)) { return true; }
			if (noSlash && globMatch(g, basename(f))) { return true; }
		}
	}
	return false;
}

/**
 * Decide whether a rule's body goes into the prompt (`inject`) or is merely listed as available
 * (`index`, R.3 agent-requested) given the current activation context.
 *
 *  - `alwaysApply: true`                         → inject
 *  - `triggers` match the user message           → inject (R.7)
 *  - `globs` match a context file                → inject (R.2, Cursor "Auto Attached")
 *  - conditional (alwaysApply:false / triggers / globs) but unmatched → index
 *  - plain rule (no frontmatter conditions)      → inject (back-compat: flat .md / AGENTS.md)
 */
export function decideRuleActivation(meta: RuleMeta, ctx: RuleActivationContext): RuleActivation {
	if (meta.alwaysApply === true) { return 'inject'; }
	if (meta.triggers.length > 0 && ctx.userText && matchesAnyTrigger(meta.triggers, ctx.userText)) { return 'inject'; }
	if (meta.globs.length > 0 && ctx.files && ctx.files.length > 0 && ruleGlobsMatchAnyFile(meta.globs, ctx.files)) { return 'inject'; }
	if (meta.alwaysApply === false || meta.triggers.length > 0 || meta.globs.length > 0) { return 'index'; }
	return 'inject';
}

/** Collect file paths from agent tool calls in the chat history (read_file/edit_file/… carry `rawParams.uri`). R.2. */
export function extractToolFilePaths(messages: ReadonlyArray<{ readonly role?: string; readonly rawParams?: unknown }>): string[] {
	const out: string[] = [];
	for (const m of messages) {
		if (!m || m.role !== 'tool') { continue; }
		const rp = m.rawParams as Record<string, unknown> | undefined;
		const uri = rp?.['uri'];
		if (typeof uri === 'string' && uri.length > 0) { out.push(uri); }
	}
	return out;
}

/**
 * Normalise an absolute (or already-relative) path to a workspace-relative, `/`-separated form
 * for glob matching. Strips the longest matching workspace-folder prefix (case-insensitive for
 * Windows). Paths outside the workspace are returned normalised but unchanged.
 */
export function toWorkspaceRelative(p: string, workspaceFsPaths: readonly string[]): string {
	const norm = p.replace(/\\/g, '/');
	let best = norm;
	for (const root of workspaceFsPaths) {
		const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
		if (r.length === 0) { continue; }
		if (norm.toLowerCase().startsWith(r.toLowerCase() + '/')) {
			const rel = norm.slice(r.length + 1);
			if (rel.length < best.length) { best = rel; }
		}
	}
	return best;
}
