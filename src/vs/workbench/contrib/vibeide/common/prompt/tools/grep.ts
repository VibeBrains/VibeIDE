/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { paginationParam, ToolDef } from './_helpers.js';

export const GREP_TOOL: ToolDef<'grep'> = {
	name: 'grep',
	description: `Ripgrep-backed content search across the workspace. ALWAYS use this for content search. NEVER use run_command with grep/rg/findstr/Select-String — those duplicate this functionality. Outputs are paginated and capped via head_limit. Choose output_mode based on what you need: "content" for matches with surrounding lines, "files_with_matches" for just file paths, "count" for per-file match counts.`,
	params: {
		pattern: { description: 'Regex pattern (Rust regex syntax — same as ripgrep).' },
		glob: { description: 'Optional. Filter files by glob (e.g. "**/*.ts", "src/**").' },
		file_type: { description: 'Optional. ripgrep file-type filter ("js", "ts", "py", "rust", "go", "java", "md", …).' },
		search_in_folder: { description: 'Optional. Restrict to a folder.' },
		output_mode: { description: 'Optional. "content" (default), "files_with_matches", or "count".' },
		context_before: { description: 'Optional. Lines of context before each match (output_mode=content only). Default 0.' },
		context_after: { description: 'Optional. Lines of context after each match (output_mode=content only). Default 0.' },
		case_insensitive: { description: 'Optional. Default false.' },
		multiline: { description: 'Optional. Default false. When true, "." matches newlines and patterns may span lines.' },
		head_limit: { description: 'Optional. Cap number of results returned. Default 250.' },
		...paginationParam,
	},
};
