/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ShellHardeningRule } from './shellHardeningTypes.js';

/**
 * Default shell-hardening ruleset shipped with VibeIDE.
 *
 * Mirrors the previously hardcoded logic in `toolHardening.ts` but expressed as
 * data so workspaces can override / extend via `.vibe/shell-hardening.json`.
 *
 * The motivation for each rule is described inline. None of these are external
 * security standards — they are VibeIDE policy choices to keep agent sessions
 * stable (long shell stdout was the primary cause of IDE hangs in early dev).
 */
export const DEFAULT_SHELL_HARDENING_RULES: readonly ShellHardeningRule[] = [
	// 1. File readers (always block when invoked head-of-command on a file).
	{
		id: 'read_file_streamers',
		bareName: '^(get-content|gc|type|cat|bat|nl|more|less)$',
		kind: 'read_file',
		suggestedTool: 'read_file',
		hint: 'Use the read_file tool for reading file contents. Shell readers like {bareName} stream through stdout and can block the IDE on large files. read_file paginates and accepts startLine/endLine.',
	},

	// 2. head/tail on a file (but not in a pipeline — `git log | head -20` is fine).
	{
		id: 'read_file_head_tail',
		bareName: '^(head|tail)$',
		requires: { notPiped: true },
		kind: 'read_file',
		suggestedTool: 'read_file',
		hint: 'Use read_file with start_line/end_line/line_limit instead of {bareName}. read_file returns numbered lines suitable for subsequent edit_file calls.',
	},

	// 3a. tree — recursive by default, always flag head-of-command.
	{
		id: 'list_tree',
		bareName: '^tree$',
		kind: 'tree',
		suggestedTool: 'get_dir_tree',
		hint: 'Use the get_dir_tree tool for recursive directory views — it respects workspace boundaries and pagination.',
	},

	// 3b. dir / ls — only block recursive forms. `/b` (Windows bare format) is
	//     NOT recursive — removed from the recursion signature compared to the
	//     legacy hardcoded version. Exempts a path that ends with a file
	//     extension token: `dir /s /b "...\file.md"` is a bounded file-existence
	//     check, not a directory dump.
	{
		id: 'list_dir',
		bareName: '^(dir|ls)$',
		requires: {
			tailMatches: '-r\\b|/s\\b|--recursive|-R\\b|-la\\b|-al\\b',
		},
		exempts: [
			// path ends with `.<2-6 char ext>` followed by quote/space/redirect/EOL
			'\\.[A-Za-z0-9]{1,6}(?:["\'\\s|&;<>]|$)',
		],
		kind: 'list_dir',
		suggestedTool: 'ls_dir',
		hint: 'Use the ls_dir tool (or glob for patterns) instead of "{bareName}". Recursive shell listings can produce huge stdout and stall the chat.',
	},

	// 4. find by name / where
	{
		id: 'search_pathnames',
		bareName: '^(find|fd|where)$',
		requires: { tailMatches: '-name\\b|--name\\b|-iname\\b' },
		kind: 'search_pathnames',
		suggestedTool: 'glob',
		hint: 'Use the glob tool with a pattern like "**/*.ts" instead of "{bareName} -name". glob uses VS Code\'s indexed search and returns URIs directly.',
	},

	// 5. Content search — block all common grep-likes head-of-command.
	{
		id: 'search_content',
		bareName: '^(grep|egrep|fgrep|rg|ag|ack|findstr|select-string|sls)$',
		kind: 'search_content',
		suggestedTool: 'grep',
		hint: 'Use the grep tool for content search. It is built on ripgrep and supports glob/type/output_mode/multiline. Shell {bareName} blows up stdout on large repos.',
	},

	// 6. In-place editors (sed -i / awk -i / perl -i).
	{
		id: 'edit_file_inplace',
		bareName: '^(sed|awk|perl)$',
		requires: { tailMatches: '-i\\b' },
		kind: 'edit_file',
		suggestedTool: 'edit_file',
		hint: 'Use the edit_file tool with SEARCH/REPLACE blocks instead of "{bareName} -i". edit_file integrates with the IDE diff view and respects per-file permissions.',
	},

	// 7a. File-writing PowerShell cmdlets invoked head-of-command
	//     (Set-Content / Add-Content / Out-File). There is no legitimate reason
	//     for the agent to write a file through the shell when rewrite_file /
	//     edit_file exist — and building a file line-by-line in PowerShell is a
	//     documented hang source (model-stalls: an unterminated here-string/quote
	//     drops the terminal into a `>>` continuation prompt that blocks until the
	//     inactivity timeout, repeated until the token budget is exhausted).
	{
		id: 'write_file_cmdlet',
		bareName: '^(set-content|add-content|out-file)$',
		kind: 'write_file',
		suggestedTool: 'rewrite_file',
		hint: 'To write a file use rewrite_file (full overwrite) or edit_file (targeted SEARCH/REPLACE) — not the shell. Shell writers bypass the IDE diff view and per-file permissions, and constructing a file line-by-line in PowerShell is error-prone (an unterminated here-string/quote drops the terminal into a ">>" continuation prompt that hangs until timeout).',
	},

	// 7b. Same write cmdlets wrapped in a shell invocation: `powershell -Command
	//     "Set-Content ..."`. Head-of-command is the shell, so 7a does not fire;
	//     match the wrapper + a write cmdlet in the tail. Reading wrappers
	//     (Get-Content) and remote writes (ssh ... tee) are intentionally NOT
	//     matched — only local file-write cmdlets.
	{
		id: 'write_file_via_shell',
		bareName: '^(powershell|pwsh)$',
		requires: { tailMatches: '\\b(?:set-content|add-content|out-file)\\b' },
		kind: 'write_file',
		suggestedTool: 'rewrite_file',
		hint: 'To write a file use rewrite_file (full overwrite) or edit_file (targeted SEARCH/REPLACE) — not "powershell -Command Set-Content/Add-Content/Out-File". Building a file line-by-line in PowerShell is error-prone: an unterminated here-string/quote drops the terminal into a ">>" continuation prompt that hangs until timeout.',
	},
];
