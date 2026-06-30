/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { BuiltinToolName, ToolApprovalType } from '../../toolsServiceTypes.js';
import { ToolDef } from './_helpers.js';

import { READ_FILE_TOOL } from './read_file.js';
import { LS_DIR_TOOL } from './ls_dir.js';
import { GET_DIR_TREE_TOOL } from './get_dir_tree.js';
import { SEARCH_PATHNAMES_ONLY_TOOL } from './search_pathnames_only.js';
import { SEARCH_FOR_FILES_TOOL } from './search_for_files.js';
import { SEARCH_IN_FILE_TOOL } from './search_in_file.js';
import { GLOB_TOOL } from './glob.js';
import { GREP_TOOL } from './grep.js';
import { READ_LINT_ERRORS_TOOL } from './read_lint_errors.js';
import { OPEN_FILE_TOOL } from './open_file.js';
import { GO_TO_DEFINITION_TOOL } from './go_to_definition.js';
import { FIND_REFERENCES_TOOL } from './find_references.js';
import { SEARCH_SYMBOLS_TOOL } from './search_symbols.js';
import { AUTOMATED_CODE_REVIEW_TOOL } from './automated_code_review.js';
import { GENERATE_TESTS_TOOL } from './generate_tests.js';
import { RENAME_SYMBOL_TOOL } from './rename_symbol.js';
import { EXTRACT_FUNCTION_TOOL } from './extract_function.js';
import { REWRITE_FILE_TOOL } from './rewrite_file.js';
import { EDIT_FILE_TOOL } from './edit_file.js';
import { CREATE_FILE_OR_FOLDER_TOOL } from './create_file_or_folder.js';
import { DELETE_FILE_OR_FOLDER_TOOL } from './delete_file_or_folder.js';
import { RUN_COMMAND_TOOL } from './run_command.js';
import { RUN_NL_COMMAND_TOOL } from './run_nl_command.js';
import { OPEN_PERSISTENT_TERMINAL_TOOL } from './open_persistent_terminal.js';
import { RUN_PERSISTENT_COMMAND_TOOL } from './run_persistent_command.js';
import { KILL_PERSISTENT_TERMINAL_TOOL } from './kill_persistent_terminal.js';
import { KILL_BACKGROUND_COMMAND_TOOL } from './kill_background_command.js';
import { READ_BACKGROUND_OUTPUT_TOOL } from './read_background_output.js';
import { WEB_SEARCH_TOOL } from './web_search.js';
import { BROWSE_URL_TOOL } from './browse_url.js';
import { VIBE_COMPLETE_TOOL } from './vibe_complete.js';

/**
 * Unified registry of all built-in tools — Kilo-style: each tool's full
 * definition (name, description, params) lives in its own module under this
 * directory, and this aggregator just imports and re-exposes them.
 *
 * The `satisfies` clause ensures the registry stays exhaustive: forgetting
 * to add a new tool here (or removing a key declared in BuiltinToolName /
 * BuiltinToolCallParams without updating the registry) is a compile error.
 *
 * Order matters for downstream presentation (prompt listing, UI), but does
 * NOT affect tool dispatch — calls are by name, never by index.
 */
export const builtinToolDefs = {
	// context-gathering (read / search / list)
	read_file: READ_FILE_TOOL,
	ls_dir: LS_DIR_TOOL,
	get_dir_tree: GET_DIR_TREE_TOOL,
	search_pathnames_only: SEARCH_PATHNAMES_ONLY_TOOL,
	search_for_files: SEARCH_FOR_FILES_TOOL,
	glob: GLOB_TOOL,
	grep: GREP_TOOL,
	search_in_file: SEARCH_IN_FILE_TOOL,
	read_lint_errors: READ_LINT_ERRORS_TOOL,
	open_file: OPEN_FILE_TOOL,
	// LSP / code navigation
	go_to_definition: GO_TO_DEFINITION_TOOL,
	find_references: FIND_REFERENCES_TOOL,
	search_symbols: SEARCH_SYMBOLS_TOOL,
	// code analysis / generation
	automated_code_review: AUTOMATED_CODE_REVIEW_TOOL,
	generate_tests: GENERATE_TESTS_TOOL,
	rename_symbol: RENAME_SYMBOL_TOOL,
	extract_function: EXTRACT_FUNCTION_TOOL,
	// editing (create / delete / overwrite)
	create_file_or_folder: CREATE_FILE_OR_FOLDER_TOOL,
	delete_file_or_folder: DELETE_FILE_OR_FOLDER_TOOL,
	edit_file: EDIT_FILE_TOOL,
	rewrite_file: REWRITE_FILE_TOOL,
	// terminal
	run_command: RUN_COMMAND_TOOL,
	run_nl_command: RUN_NL_COMMAND_TOOL,
	run_persistent_command: RUN_PERSISTENT_COMMAND_TOOL,
	open_persistent_terminal: OPEN_PERSISTENT_TERMINAL_TOOL,
	kill_persistent_terminal: KILL_PERSISTENT_TERMINAL_TOOL,
	kill_background_command: KILL_BACKGROUND_COMMAND_TOOL,
	read_background_output: READ_BACKGROUND_OUTPUT_TOOL,
	// web
	web_search: WEB_SEARCH_TOOL,
	browse_url: BROWSE_URL_TOOL,
	// agent control
	vibe_complete: VIBE_COMPLETE_TOOL,
} satisfies { [T in BuiltinToolName]: ToolDef<T> };

/**
 * Derived map: built-in tool name → its approval category (or absent for
 * read-only tools). Computed from each `ToolDef.approvalType` field in the
 * registry above — single source of truth, no parallel hand-curated list.
 *
 * Shape matches the previously hand-curated Record in `toolsServiceTypes.ts`
 * so consumer code (`(toolName as string) in approvalTypeOfBuiltinToolName`
 * and direct key lookup) keeps working without changes — only the import
 * path moves.
 *
 * Old hand-curated version (toolsServiceTypes.ts:26-38 before this refactor):
 *   create_file_or_folder/delete_file_or_folder/rewrite_file/edit_file → 'edits';
 *   run_command/run_nl_command/run_persistent_command/open_persistent_terminal/
 *   kill_persistent_terminal/kill_background_command/read_background_output → 'terminal'.
 * New derived version (this expression) MUST match — verified by an inline
 * `satisfies` plus an at-startup sanity check would be overkill since
 * TypeScript already enforces that every `approvalType` value in any tool
 * module is a `ToolApprovalType` literal.
 */
export const approvalTypeOfBuiltinToolName: Partial<{ [T in BuiltinToolName]?: ToolApprovalType }> = (() => {
	const out: Partial<{ [T in BuiltinToolName]?: ToolApprovalType }> = {};
	for (const [toolName, def] of Object.entries(builtinToolDefs)) {
		if (def.approvalType) {
			out[toolName as BuiltinToolName] = def.approvalType;
		}
	}
	return out;
})();
