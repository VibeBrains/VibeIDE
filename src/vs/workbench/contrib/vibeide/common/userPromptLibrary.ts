/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * User-defined prompt library — `.vibe/prompts/<name>.md` loader (pure helpers).
 *
 * Each prompt file is markdown with optional YAML-ish frontmatter:
 *
 *   ---
 *   name: rename-symbols
 *   mode: ctrl-k          # 'chat' | 'ctrl-k'
 *   model: claude-opus-4-7   # optional model override
 *   params:
 *     - name: target
 *       ask: "What to rename to?"
 *   ---
 *   Rename all occurrences of {{selection}} to {{ask:target}}. Keep
 *   semantics identical. File: {{file}}.
 *
 * Placeholders `{{selection}}`, `{{file}}`, `{{ask:NAME}}` are resolved
 * at invocation time (browser-side: selection from editor, file from URI,
 * ask from QuickPick prompt).
 *
 * Loader-side responsibilities (this file):
 *  - parse frontmatter (no YAML lib dep — accept only the small subset above)
 *  - validate required fields (`name`, `mode`)
 *  - extract placeholder references for caller to resolve at invocation
 *
 * IO + UI integration (read fs, register Command Palette entries) is wave-2.
 */

export type UserPromptMode = 'chat' | 'ctrl-k';

export interface UserPromptParam {
	readonly name: string;
	readonly ask: string;
}

export interface UserPrompt {
	readonly name: string;
	readonly mode: UserPromptMode;
	readonly model?: string;
	readonly params: readonly UserPromptParam[];
	readonly template: string;
}

export interface ParsedPlaceholder {
	readonly kind: 'selection' | 'file' | 'ask';
	readonly arg?: string;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
const PLACEHOLDER_RE = /\{\{(selection|file|ask:([a-zA-Z_][\w-]*))\}\}/g;

/**
 * Parse a `.vibe/prompts/<name>.md` file body. Returns null on invalid input
 * (missing frontmatter, unknown mode, malformed params). Caller usually
 * surfaces validation errors via notification when loading the library.
 *
 * `fallbackName` is used as the prompt name when frontmatter doesn't supply
 * one — typically the basename of the source file.
 */
export function parseUserPromptFile(raw: string, fallbackName: string): UserPrompt | null {
	if (typeof raw !== 'string') { return null; }
	const m = FRONTMATTER_RE.exec(raw);
	let frontmatter = '';
	let template = '';
	if (m) {
		frontmatter = m[1];
		template = m[2];
	} else {
		// No frontmatter — entire file is the template, mode defaults to 'chat'.
		template = raw;
	}

	const fields = parseFrontmatterFields(frontmatter);
	const name = (fields['name'] ?? fallbackName).trim();
	if (!name) { return null; }

	const rawMode = (fields['mode'] ?? 'chat').trim().toLowerCase();
	if (rawMode !== 'chat' && rawMode !== 'ctrl-k') { return null; }
	const mode = rawMode as UserPromptMode;

	const model = fields['model']?.trim() || undefined;
	const params = parseParamsBlock(fields['params'] ?? '');
	if (params === null) { return null; }

	return {
		name,
		mode,
		model,
		params,
		template: template.trim(),
	};
}

/**
 * List all placeholders the template uses. Caller resolves them before
 * substituting (e.g., shows QuickPick for each `ask:NAME`).
 */
export function listPlaceholders(template: string): readonly ParsedPlaceholder[] {
	if (typeof template !== 'string') { return []; }
	const out: ParsedPlaceholder[] = [];
	const seen = new Set<string>();
	for (const m of template.matchAll(PLACEHOLDER_RE)) {
		const raw = m[1];
		if (seen.has(raw)) { continue; }
		seen.add(raw);
		if (raw === 'selection') { out.push({ kind: 'selection' }); }
		else if (raw === 'file') { out.push({ kind: 'file' }); }
		else { out.push({ kind: 'ask', arg: m[2] }); }
	}
	return out;
}

/**
 * Substitute placeholders. `selection`, `file`, and each `ask:NAME` value
 * come from the resolver map. Missing values fall back to an empty string
 * (caller is expected to validate before calling).
 */
export function expandUserPrompt(
	template: string,
	values: Readonly<Record<string, string>>,
): string {
	if (typeof template !== 'string') { return ''; }
	return template.replace(PLACEHOLDER_RE, (_full, raw, _askName) => {
		if (raw === 'selection') { return values['selection'] ?? ''; }
		if (raw === 'file') { return values['file'] ?? ''; }
		const askKey = `ask:${(raw as string).slice(4)}`;
		return values[askKey] ?? '';
	});
}

function parseFrontmatterFields(block: string): Record<string, string> {
	const out: Record<string, string> = {};
	let currentKey: string | null = null;
	let buf: string[] = [];
	const flush = () => {
		if (currentKey !== null) {
			out[currentKey] = buf.join('\n').replace(/^\s*\n/, '').trimEnd();
		}
		currentKey = null;
		buf = [];
	};
	for (const line of block.split(/\r?\n/)) {
		const headerMatch = /^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (headerMatch && !/^\s/.test(line)) {
			flush();
			currentKey = headerMatch[1];
			buf = [headerMatch[2]];
		} else if (currentKey !== null) {
			buf.push(line);
		}
	}
	flush();
	return out;
}

function parseParamsBlock(raw: string): UserPromptParam[] | null {
	if (!raw.trim()) { return []; }
	const params: UserPromptParam[] = [];
	let current: { name?: string; ask?: string } = {};
	const finalize = () => {
		if (current.name && current.ask !== undefined) {
			params.push({ name: current.name, ask: current.ask });
		} else if (current.name || current.ask) {
			// Incomplete entry — invalid file.
			return false;
		}
		current = {};
		return true;
	};
	const lines = raw.split(/\r?\n/);
	for (const line of lines) {
		const newItem = /^\s*-\s+name\s*:\s*(.+)$/.exec(line);
		if (newItem) {
			if (!finalize()) { return null; }
			current.name = newItem[1].trim();
			continue;
		}
		const askLine = /^\s+ask\s*:\s*(.+)$/.exec(line);
		if (askLine) {
			current.ask = stripQuotes(askLine[1].trim());
			continue;
		}
		// Other indented lines are ignored (lenient parser — we only care about
		// `name` + `ask` shape).
	}
	if (!finalize()) { return null; }
	return params;
}

function stripQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) {
		return s.slice(1, -1);
	}
	return s;
}
