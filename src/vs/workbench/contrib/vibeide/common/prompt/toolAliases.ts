/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


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
	'write_to_file': 'rewrite_file', // Cline/Roo/Kilo canonical write tool — aggregator-trained models emit it; params path+content map cleanly to uri+new_content
	'delete': 'delete_file_or_folder',
	'rm': 'delete_file_or_folder',
	'remove': 'delete_file_or_folder',
	// web tools (Kilo Code names)
	'fetch': 'browse_url',
	'webfetch': 'browse_url',
	'web_fetch': 'browse_url',
	// end-of-turn / completion (Cline/Roo/Kilo emit `attempt_completion`; others vary)
	'attempt_completion': 'vibe_complete',
	'complete_task': 'vibe_complete',
	'task_complete': 'vibe_complete',
	'mark_task_complete': 'vibe_complete',
	'finish': 'vibe_complete',
	'finish_task': 'vibe_complete',
	'done': 'vibe_complete',
	'complete': 'vibe_complete',
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
		// Flat str_replace form is now first-class. `old_string`/`new_string` are canonical (passthrough);
		// map the Cline/Anthropic underscore + text variants onto them. Validation collapses old/new into
		// a single SEARCH/REPLACE block, so the model never has to emit the marker blob itself.
		old_str: 'old_string', new_str: 'new_string',
		oldtext: 'old_string', newtext: 'new_string', old_text: 'old_string', new_text: 'new_string',
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
		// browse_url's canonical param is `url` (NOT the file-tool `uri`) — it reads `params.url`.
		// Normalize foreign location names TO `url`; never remap `url` itself (that left params.url
		// undefined and broke the tool for every input).
		uri: 'url', link: 'url', href: 'url',
	},
	vibe_complete: {
		// Cline/Roo `attempt_completion` carries the closing text in `result`; others vary.
		result: 'summary', text: 'summary', message: 'summary', content: 'summary',
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
	if (!map) { return rawParams; }
	const out: { [k: string]: unknown } = {};
	for (const k of Object.keys(rawParams)) {
		const lower = k.toLowerCase();
		const canonical = map[lower] ?? k;
		// First-wins: if the canonical name is already populated (e.g. model sent
		// both `path` and `uri`), don't overwrite the canonical with the alias.
		if (Object.hasOwn(out, canonical)) { continue; }
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
	if (isCanonical(rawName)) { return rawName; }
	const lowered = rawName.toLowerCase();
	if (lowered !== rawName && isCanonical(lowered)) { return lowered; }
	const aliasTarget = TOOL_NAME_ALIASES[lowered];
	if (aliasTarget && isCanonical(aliasTarget)) { return aliasTarget; }
	return null;
};

// Tools that legitimately OWN a shared required field. The shape-router must
// never re-route FROM one of these for that field — that would hijack a valid
// call (e.g. a real `search_pathnames_only` getting turned into
// `search_for_files`). Centralized here, next to the schemas they mirror.
const COMMAND_OWNING_TOOLS: ReadonlySet<string> = new Set(['run_command', 'run_persistent_command']);
const QUERY_OWNING_TOOLS: ReadonlySet<string> = new Set(['search_for_files', 'search_pathnames_only', 'search_symbols', 'search_in_file']);
// Non-uri tools: their required field is command/query/pattern, so a bare
// `{uri}` from them is an unambiguous misname → read_file. Tools that take a
// `uri` (read_file, ls_dir, get_dir_tree, search_in_file, go_to_definition, …)
// are deliberately absent so a legitimate `{uri}` call is left untouched.
const NON_URI_TOOLS: ReadonlySet<string> = new Set(['run_command', 'run_persistent_command', 'run_nl_command', 'search_for_files', 'search_pathnames_only', 'grep', 'glob']);
// `pattern` is shared by glob and grep, so a bare `{pattern[, search_in_folder, page_number]}`
// shape under a NON-pattern tool is a misname (#014: minimax emitted `read_file ← {pattern:"**/nginx.conf"}`).
const PATTERN_OWNING_TOOLS: ReadonlySet<string> = new Set(['glob', 'grep']);
// Regex-only constructs that a filename glob never uses → grep. Note `.` is excluded (it appears in
// filenames like `.conf`); only a dot FOLLOWED by a quantifier (`.*`, `.+`, `.?`) reads as regex.
const PATTERN_REGEX_ONLY = /[\^$\\|+()\[\]]|\.[*+?]/;
// Path-glob markers a regex search pattern essentially never carries.
const PATTERN_GLOB_SIGNAL = /\*\*|\/|\{|\*\.|^\*|\?/;
/**
 * Disambiguate a shared `{pattern}` between glob and grep by syntax (roadmap 3226):
 * path-glob markers with NO regex-only metachars → `glob`; otherwise → `grep`. Conservative —
 * any regex-only construct (anchors, escapes, alternation, `.*`) falls to grep.
 */
const classifyPatternTool = (pattern: string): 'glob' | 'grep' =>
	(PATTERN_GLOB_SIGNAL.test(pattern) && !PATTERN_REGEX_ONLY.test(pattern)) ? 'glob' : 'grep';

/**
 * Shape-based tool-name correction. Aggregator-proxied models (deepseek/minimax/
 * qwen/nemotron via openCodeGo & co.) routinely emit the RIGHT params under the
 * WRONG tool name. Map an unambiguous param SHAPE back to the tool it belongs to
 * so we run what the model obviously meant instead of bouncing schema hints (the
 * invalid_params loop that burns the whole token budget — model-stalls #010).
 *
 * Matches the SHAPE, never the model name (no per-provider hardcode). Returns a
 * canonical builtin tool name only when the shape uniquely belongs to ONE tool
 * AND the requested tool does not itself own that shape's required field;
 * otherwise (ambiguous / already-correct / legitimate sibling) returns undefined
 * and the call falls through to normal validation. The caller still verifies the
 * returned name via `isABuiltinToolName`.
 */
export const detectToolByParamShape = (
	params: { readonly [k: string]: unknown } | undefined,
	requestedToolName: string,
): string | undefined => {
	if (!params || typeof params !== 'object') { return undefined; }
	const keys = Object.keys(params);
	if (keys.length === 0) { return undefined; }
	const hasStr = (k: string) => typeof params[k] === 'string' && (params[k] as string).length > 0;

	// {command, cwd?, timeout_ms?, run_in_background?} → run_command.
	if (hasStr('command') && keys.every(k => k === 'command' || k === 'cwd' || k === 'timeout_ms' || k === 'run_in_background')) {
		return COMMAND_OWNING_TOOLS.has(requestedToolName) ? undefined : 'run_command';
	}
	// {nl_input, cwd?} → run_nl_command. `nl_input` is owned SOLELY by run_nl_command
	// (no other tool declares it), so this shape is unambiguous — reroute unless the call
	// is already run_nl_command. This is the safe subset of cross-tool arg re-routing
	// (roadmap 1712); the general "args belong to another tool" case stays deferred because
	// shared params (path/query/…) make it ambiguous, but a distinctive owner-only param is safe.
	if (hasStr('nl_input') && keys.every(k => k === 'nl_input' || k === 'cwd')) {
		return requestedToolName === 'run_nl_command' ? undefined : 'run_nl_command';
	}
	// {query, search_in_folder?, is_regex?, page_number?} WITHOUT uri → search_for_files
	// (search_in_file pairs query WITH uri, so the `!uri` guard disambiguates it).
	if (hasStr('query') && !Object.hasOwn(params, 'uri') && keys.every(k => k === 'query' || k === 'search_in_folder' || k === 'is_regex' || k === 'page_number')) {
		return QUERY_OWNING_TOOLS.has(requestedToolName) ? undefined : 'search_for_files';
	}
	// {pattern[, search_in_folder, page_number]} WITHOUT uri -> glob/grep by pattern syntax
	// (roadmap 3226 / #014). Only this MINIMAL shared shape triggers: a real grep carrying
	// output_mode/file_type/glob/... won't satisfy keys.every(...), so rich grep calls pass
	// through untouched. Never re-route FROM glob/grep -- they own `pattern`.
	if (hasStr('pattern') && !Object.hasOwn(params, 'uri')
		&& keys.every(k => k === 'pattern' || k === 'search_in_folder' || k === 'page_number')) {
		return PATTERN_OWNING_TOOLS.has(requestedToolName) ? undefined : classifyPatternTool(params['pattern'] as string);
	}
	// {uri, <read pagination>} with no command/query/pattern → read_file, but only
	// from a NON-uri tool (a bare {uri} is ambiguous with ls_dir/get_dir_tree/…).
	// {uri[, page_number]} whose uri ends in a path separator (an unambiguous directory)
	// → ls_dir, from a NON-uri tool. Checked BEFORE the read_file branch so a trailing-slash
	// uri routes to ls_dir while a file path falls through to it. Trailing slash is the ONLY
	// directory signal used: a name without an extension (LICENSE, Makefile, Dockerfile) is a
	// FILE, so "no extension" is deliberately NOT treated as a directory (would misroute reads).
	if (hasStr('uri') && !hasStr('command') && !hasStr('query') && !Object.hasOwn(params, 'pattern')
		&& keys.every(k => k === 'uri' || k === 'page_number')
		&& NON_URI_TOOLS.has(requestedToolName)
		&& /[/\\]\s*$/.test(params['uri'] as string)) {
		return 'ls_dir';
	}
	if (hasStr('uri') && !hasStr('command') && !hasStr('query') && !Object.hasOwn(params, 'pattern')
		&& keys.every(k => k === 'uri' || k === 'start_line' || k === 'end_line' || k === 'page_number' || k === 'line_limit' || k === 'with_line_numbers')
		&& NON_URI_TOOLS.has(requestedToolName)) {
		return 'read_file';
	}
	return undefined;
};
