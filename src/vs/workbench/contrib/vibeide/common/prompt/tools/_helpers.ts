/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { searchReplaceBlockTemplate } from './_constants.js';
import { BuiltinToolCallParams, BuiltinToolName, ToolApprovalType } from '../../toolsServiceTypes.js';
import { SnakeCaseKeys } from '../snakeCase.js';

/**
 * The shape each per-tool module exports. `name` is the canonical lower-snake
 * identifier the model emits; `params` mirrors the snake-cased BuiltinToolCallParams
 * keys so the aggregator's `satisfies` clause catches drift between the tool's
 * call params and its prompt-facing param descriptions.
 *
 * `approvalType` declares whether the tool has user-visible side effects, and
 * if so what category. Absent / undefined = read-only (no approval required;
 * also exempt from plan-step `tools` allowlist drift checks). Side-effect
 * tools must declare 'edits' (filesystem writes) or 'terminal' (process /
 * shell). The derived `approvalTypeOfBuiltinToolName` Record in
 * `prompt/tools/index.ts` is computed from this field — single source of
 * truth, no parallel hand-curated list to drift.
 */
export type ToolDef<T extends BuiltinToolName> = {
	readonly name: T;
	readonly description: string;
	readonly params: Partial<{ readonly [paramName in keyof SnakeCaseKeys<BuiltinToolCallParams[T]>]: { readonly description: string } }>;
	readonly approvalType?: ToolApprovalType;
};

// Shared parameter snippets and prose helpers for built-in tool descriptions.
// Per-tool modules import from here; this module only depends on _constants.ts,
// keeping the dependency arrow strictly one-way (tools/* → _helpers → _constants).

export const uriParam = (object: string) => ({
	uri: { description: `The FULL path to the ${object}.` }
});

export const paginationParam = {
	page_number: { description: 'Optional. The page number of the result. Default is 1.' }
} as const;

export const terminalDescHelper = `Use this for build/test/git/package-manager/dev-server commands.
DO NOT use this to read files, list directories, search file names, or search content. Those duplicate dedicated tools, blow up stdout on large inputs, and can hang the chat.
Instead of  →  use:
- cat/Get-Content/type/head/tail  →  read_file (paginated, returns numbered lines)
- ls -R / dir /s / tree            →  ls_dir / get_dir_tree (workspace-aware, paginated)
- find -name / where               →  glob (pattern like **/*.ts)
- grep/rg/findstr/Select-String    →  grep (ripgrep-backed; supports glob/type/output_mode)
- sed -i / awk -i                  →  edit_file (SEARCH/REPLACE; integrates with diff view)
The validator will reject these shell forms with a structured error and suggest the correct tool.
NEVER edit or generate file contents through the shell — no node -e/python -c file surgery, no > / >> redirects into source files, no here-strings (cat <<EOF, @'...'@) — and NEVER create a throwaway script file (e.g. fix-*.js) just to transform code. Apply the change directly with edit_file (partial edits) or rewrite_file (whole file). Shell-based file edits break on quoting and multi-line input (especially PowerShell's >> continuation prompt) and leave stray files behind. The terminal is for build/test/git/package-manager/dev-server commands only.
When piping git or other paged commands, pipe through cat to avoid getting stuck in a pager.`;

export const cwdHelper = 'Optional. The directory in which to run the command. Defaults to the first workspace folder.';

export const replaceTool_description = `\
A string of SEARCH/REPLACE block(s) which will be applied to the given file.
Your SEARCH/REPLACE blocks string must be formatted as follows:
${searchReplaceBlockTemplate}

## Guidelines:

1. You may output multiple search replace blocks if needed.

2. The ORIGINAL code in each SEARCH/REPLACE block must EXACTLY match lines in the original file. Do not add or remove any whitespace or comments from the original code.

3. Each ORIGINAL text must be large enough to uniquely identify the change. However, bias towards writing as little as possible.

4. Each ORIGINAL text must be DISJOINT from all other ORIGINAL text.

5. This field is a STRING (not an array).`;
