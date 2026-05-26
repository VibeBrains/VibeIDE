/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Cross-ecosystem tool-call aliases. Models trained on Anthropic / Cursor /
// Kilo Code / OpenAI tool catalogs emit names and param fields specific to
// those ecosystems (`bash`, `view`, `str_replace_editor`, `read`, `path`,
// `filePath`, etc.) rather than VibeIDE's canonical snake_case names. We
// rewrite both at the dispatcher level so every channel (AI SDK native
// function-calling, legacy native, XML fallback) shares the same recovery.
//
// Lookup is case-insensitive: callers must lowercase the raw name before
// indexing into either map.
//
// Sourced from extractGrammar.ts (was XML-only) and expanded with Kilo Code's
// canonical names (read, edit, apply_patch, fetch) that VibeIDE intentionally
// renamed for clarity but that minimax / qwen / older Claude variants still
// emit by training.

/**
 * One-direction map: alias (lowercase) → canonical VibeIDE tool name.
 *
 * Canonical names are always matched first by `isABuiltinToolName(name)`;
 * the alias map only kicks in when the raw name is not already a registered
 * tool. Do NOT add entries whose alias equals a real canonical (would
 * clobber it during fallback).
 */
export const TOOL_NAME_ALIASES: { readonly [alias: string]: string } = {
	// Anthropic / generic shell aliases
	'bash': 'run_command',
	'shell': 'run_command',
	'cmd': 'run_command',
	'powershell': 'run_command',
	'pwsh': 'run_command',
	'execute_command': 'run_command',
	'execute': 'run_command',
	'terminal': 'run_command',
	// Anthropic file-view / OpenAI / Kilo variants
	'read': 'read_file', // Kilo Code's canonical name
	'view': 'read_file',
	'view_file': 'read_file',
	'cat': 'read_file',
	'open': 'read_file', // careful: VibeIDE has open_file; if we ever want both, drop this row
	// Anthropic str_replace editor / generic edit / Kilo apply_patch
	'edit': 'edit_file', // Kilo Code's canonical name
	'apply_patch': 'edit_file', // Kilo Code's patch tool
	'patch': 'edit_file',
	'str_replace_editor': 'edit_file',
	'str_replace': 'edit_file',
	'editor': 'edit_file',
	// directory listing
	'list_files': 'ls_dir',
	'list_dir': 'ls_dir',
	'list_directory': 'ls_dir',
	'ls': 'ls_dir',
	'dir': 'ls_dir',
	// pattern / content search
	'find': 'glob',
	'glob_files': 'glob',
	'search': 'grep',
	'ripgrep': 'grep',
	'rg': 'grep',
	'grep_search': 'grep', // Cursor's content-search tool name
	'search_content': 'grep', // observed from deepseek-v4-pro (model-stalls #008)
	'content_search': 'grep',
	'search_text': 'grep',
	// create / write / delete
	'create': 'create_file_or_folder',
	'create_file': 'create_file_or_folder',
	'mkdir': 'create_file_or_folder',
	'write_file': 'rewrite_file',
	'write': 'rewrite_file',
	'delete': 'delete_file_or_folder',
	'rm': 'delete_file_or_folder',
	'remove': 'delete_file_or_folder',
	// web tools (Kilo Code names)
	'fetch': 'browse_url',
	'webfetch': 'browse_url',
	'web_fetch': 'browse_url',
	// Word-order-swapped concept anchors (observed: deepseek-v4-pro emitted
	// `<file_read file="..." />` / `<FileRead .../>` instead of canonical
	// `read_file`). These map the *word order* `file_<verb>` → canonical; the
	// separator/case-insensitive resolver (`resolveToolNameLoose` + normToolKey in
	// xmlToolNormalize) then makes ONE entry cover every spelling — `file_read`,
	// `FileRead`, `fileRead`, `FILE_READ` all normalize to `fileread` → here. We
	// map concepts, never spellings. None collide with a canonical name.
	'file_read': 'read_file',
	'file_write': 'rewrite_file',
	'file_edit': 'edit_file',
	'file_create': 'create_file_or_folder',
	'file_delete': 'delete_file_or_folder',
	// `file_search` (Cursor's fuzzy filename tool) — deepseek-v4-pro emitted
	// `<file_search pattern="specification.md" directory="..." />`. Maps to our
	// filename search (`pattern`/`filename` already alias to `query`); the extra
	// `directory` attr has no canonical param and is ignored by validateParams
	// (which destructures only query/search_in_folder/page_number), so the tag
	// still executes cleanly instead of leaking.
	'file_search': 'search_pathnames_only',
};

/**
 * Per-tool param-name alias map: canonical tool name → { lowercase alias → canonical param }.
 *
 * Models from various ecosystems use different field names for the same
 * concept — most commonly `path` / `file_path` / `filePath` / `file` for our
 * `uri`. The XML-path resolveInvokeParamName already applied this; the
 * dispatcher now applies the same map for AI SDK native-FC and legacy native
 * channels, so `{path: "..."}` and `{filePath: "..."}` and `{file_path:
 * "..."}` all reach validation as `{uri: "..."}`.
 *
 * Keys are lowercase; callers lowercase the raw param name before indexing.
 */
export const PARAM_ALIASES_BY_TOOL: { readonly [canonicalToolName: string]: { readonly [alias: string]: string } } = {
	read_file: {
		path: 'uri', file_path: 'uri', filepath: 'uri', file: 'uri', filename: 'uri',
		// Kilo Code's read tool uses offset/limit; VibeIDE uses start_line / line_limit.
		offset: 'start_line',
		limit: 'line_limit',
		max_lines: 'line_limit',
	},
	edit_file: {
		path: 'uri', file_path: 'uri', filepath: 'uri', file: 'uri',
		old_str: 'search_replace_blocks', old_string: 'search_replace_blocks',
		// Note: edit_file expects a single SEARCH/REPLACE blob, not separate old/new fields.
		// If a model passes old_str + new_str separately, only old_str is captured here;
		// the SEARCH/REPLACE format must still be assembled by the model. The prompt is
		// tightened to make this explicit.
	},
	rewrite_file: {
		path: 'uri', file_path: 'uri', filepath: 'uri', file: 'uri',
		content: 'new_content', code: 'new_content', text: 'new_content', body: 'new_content',
	},
	create_file_or_folder: {
		path: 'uri', file_path: 'uri', filepath: 'uri', file: 'uri', dir: 'uri', folder: 'uri',
	},
	delete_file_or_folder: {
		path: 'uri', file_path: 'uri', filepath: 'uri', file: 'uri', recursive: 'is_recursive',
	},
	ls_dir: {
		path: 'uri', filepath: 'uri', directory: 'uri', folder: 'uri', dir: 'uri',
	},
	get_dir_tree: {
		path: 'uri', filepath: 'uri', directory: 'uri', folder: 'uri', dir: 'uri',
	},
	glob: {
		glob: 'pattern', glob_pattern: 'pattern', pattern_glob: 'pattern', path_pattern: 'pattern',
	},
	grep: {
		// `path_pattern` — qwen-family native-FC param hallucination (model-quirks qwen note).
		query: 'pattern', regex: 'pattern', search: 'pattern', path_pattern: 'pattern',
	},
	search_for_files: {
		pattern: 'query', search: 'query',
	},
	search_pathnames_only: {
		pattern: 'query', search: 'query', filename: 'query',
	},
	open_file: {
		path: 'uri', file_path: 'uri', filepath: 'uri', file: 'uri',
	},
	run_command: {
		// most models use `command` already — just normalize a few stragglers
		cmd: 'command',
		shell_command: 'command',
		bash_command: 'command',
		ps_command: 'command',
		working_directory: 'cwd',
		dir: 'cwd',
		path: 'cwd',
		timeout: 'timeout_ms',
		background: 'run_in_background',
		detach: 'run_in_background',
	},
	browse_url: {
		url: 'uri', link: 'uri', href: 'uri',
	},
};

/**
 * Rewrite param-keys of a raw tool-call params object through the alias map
 * for the given canonical tool name. Keys not in the alias map pass through
 * unchanged. Returns a new object — does not mutate the input.
 *
 * Used at the dispatcher level (chatThreadService._runToolCall) before
 * validateParams, so AI SDK native-FC and legacy native channels get the
 * same alias treatment as the XML extraction path.
 */
export const applyParamAliases = (
	canonicalToolName: string,
	rawParams: { [k: string]: unknown },
): { [k: string]: unknown } => {
	const map = PARAM_ALIASES_BY_TOOL[canonicalToolName];
	if (!map) return rawParams;
	const out: { [k: string]: unknown } = {};
	for (const k of Object.keys(rawParams)) {
		const lower = k.toLowerCase();
		const canonical = map[lower] ?? k;
		// First-wins: if the canonical name is already populated (e.g. model sent
		// both `path` and `uri`), don't overwrite the canonical with the alias.
		if (canonical in out) continue;
		out[canonical] = rawParams[k];
	}
	return out;
};

/**
 * Resolve a raw tool name to a canonical VibeIDE tool name via aliases.
 * Returns null if no canonical match (caller decides what to do).
 *
 * Steps:
 *   1. Exact match against `isCanonical` predicate.
 *   2. Lowercase variant against `isCanonical` (handles Read_File / BASH).
 *   3. Alias lookup (`bash` → `run_command`, `read` → `read_file`, etc.)
 *      with target verified by `isCanonical`.
 */
export const resolveToolNameAlias = (
	rawName: string,
	isCanonical: (name: string) => boolean,
): string | null => {
	if (isCanonical(rawName)) return rawName;
	const lowered = rawName.toLowerCase();
	if (lowered !== rawName && isCanonical(lowered)) return lowered;
	const aliasTarget = TOOL_NAME_ALIASES[lowered];
	if (aliasTarget && isCanonical(aliasTarget)) return aliasTarget;
	return null;
};
