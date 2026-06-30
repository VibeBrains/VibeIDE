/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { URI } from '../../../../base/common/uri.js';
import { RawMCPToolCall } from './mcpServiceTypes.js';
import { SnakeCaseKeys } from './prompt/snakeCase.js';
import { RawToolParamsObj } from './sendLLMMessageTypes.js';



export type TerminalResolveReason = { type: 'timeout' } | { type: 'done'; exitCode: number };

export type LintErrorItem = { code: string; message: string; startLineNumber: number; endLineNumber: number };

// Partial of IFileStat
export type ShallowDirectoryItem = {
	uri: URI;
	name: string;
	isDirectory: boolean;
	isSymbolicLink: boolean;
};


/**
 * Categories of user-approval required for a tool. `'MCP tools'` is the
 * generic bucket for external MCP servers — built-in tools never use it
 * (their categories are 'edits' / 'terminal').
 *
 * The mapping `(builtin tool name) → ToolApprovalType` is no longer hand-
 * curated here — each per-tool module under `prompt/tools/*` declares its
 * own `approvalType` field on its `ToolDef`, and the consolidated Record
 * `approvalTypeOfBuiltinToolName` is DERIVED from `builtinToolDefs` in
 * `prompt/tools/index.ts`. Single source of truth = each tool's module.
 *
 * Consumers that need the runtime Record import it from prompt/tools:
 *   import { approvalTypeOfBuiltinToolName } from '../common/prompt/tools/index.js'
 */
export type ToolApprovalType = 'edits' | 'terminal' | 'MCP tools';

export const toolApprovalTypes = new Set<ToolApprovalType>(['edits', 'terminal', 'MCP tools']);




// PARAMS OF TOOL CALL
export type BuiltinToolCallParams = {
	'read_file': { uri: URI; startLine: number | null; endLine: number | null; pageNumber: number; lineLimit: number | null; withLineNumbers: boolean };
	'ls_dir': { uri: URI; pageNumber: number };
	'get_dir_tree': { uri: URI };
	'search_pathnames_only': { query: string; includePattern: string | null; pageNumber: number };
	'search_for_files': { query: string; isRegex: boolean; searchInFolder: URI | null; pageNumber: number };
	'search_in_file': { uri: URI; query: string; isRegex: boolean };
	'glob': { pattern: string; searchInFolder: URI | null; pageNumber: number };
	'grep': { pattern: string; glob: string | null; fileType: string | null; searchInFolder: URI | null; outputMode: 'content' | 'files_with_matches' | 'count'; contextBefore: number; contextAfter: number; caseInsensitive: boolean; multiline: boolean; headLimit: number; pageNumber: number };
	'read_lint_errors': { uri: URI };
	'open_file': { uri: URI };
	'go_to_definition': { uri: URI; line: number; column: number };
	'find_references': { uri: URI; line: number; column: number };
	'search_symbols': { query: string; uri: URI | null };
	'automated_code_review': { uri: URI };
	'generate_tests': { uri: URI; functionName?: string; testFramework?: string };
	'rename_symbol': { uri: URI; line: number; column: number; newName: string };
	'extract_function': { uri: URI; startLine: number; endLine: number; functionName: string };
	// ---
	'rewrite_file': { uri: URI; newContent: string };
	// `searchReplaceBlocks` is the multi-marker form; `oldString`/`newString` are the flat str_replace
	// form (easier for weaker models — they emit two plain string params instead of a marker blob).
	// Validation collapses old/new into a single block, so the exec handler only reads
	// `searchReplaceBlocks`; the flat fields are schema-facing only.
	'edit_file': { uri: URI; searchReplaceBlocks: string; oldString?: string; newString?: string };
	'create_file_or_folder': { uri: URI; isFolder: boolean };
	'delete_file_or_folder': { uri: URI; isRecursive: boolean; isFolder: boolean };
	// ---
	'run_command': { command: string; cwd: string | null; terminalId: string; timeoutMs: number | null; runInBackground: boolean };
	'run_nl_command': { nlInput: string; cwd: string | null; terminalId: string };
	'open_persistent_terminal': { cwd: string | null };
	'run_persistent_command': { command: string; persistentTerminalId: string; timeoutMs: number | null };
	'kill_persistent_terminal': { persistentTerminalId: string };
	'kill_background_command': { backgroundId: string };
	'read_background_output': { backgroundId: string };
	// ---
	'web_search': { query: string; k?: number; refresh?: boolean };
	'browse_url': { url: string; refresh?: boolean };
	// ---
	'vibe_complete': { summary: string };
};

// RESULT OF TOOL CALL
export type BuiltinToolResultType = {
	'read_file': { fileContents: string; totalFileLen: number; totalNumLines: number; hasNextPage: boolean; linesReturned: number; startLineReturned: number; endLineReturned: number; truncatedByLineLimit: boolean };
	'ls_dir': { children: ShallowDirectoryItem[] | null; hasNextPage: boolean; hasPrevPage: boolean; itemsRemaining: number };
	'get_dir_tree': { str: string };
	'search_pathnames_only': { uris: URI[]; hasNextPage: boolean; limitHit: boolean };
	'search_for_files': { uris: URI[]; hasNextPage: boolean };
	'search_in_file': { lines: number[] };
	'glob': { uris: URI[]; hasNextPage: boolean; totalMatches: number; limitHit: boolean };
	'grep': { mode: 'content' | 'files_with_matches' | 'count'; matches: Array<{ uri: URI; line: number; column: number; preview: string }>; files: Array<{ uri: URI; count?: number }>; hasNextPage: boolean; totalMatches: number };
	'read_lint_errors': { lintErrors: LintErrorItem[] | null };
	'open_file': {};
	'go_to_definition': { locations: Array<{ uri: URI; startLine: number; startColumn: number; endLine: number; endColumn: number }> };
	'find_references': { locations: Array<{ uri: URI; startLine: number; startColumn: number; endLine: number; endColumn: number }> };
	'search_symbols': { symbols: Array<{ name: string; kind: string; uri: URI; startLine: number; startColumn: number; endLine: number; endColumn: number }> };
	'automated_code_review': { issues: Array<{ severity: 'error' | 'warning' | 'info'; message: string; line: number; column: number; suggestion?: string }> };
	'generate_tests': { testCode: string; testFileUri: URI };
	'rename_symbol': { changes: Array<{ uri: URI; oldText: string; newText: string; line: number; column: number }> };
	'extract_function': { newFunctionCode: string; replacementCode: string; insertLine: number };
	// ---
	'rewrite_file': Promise<{ lintErrors: LintErrorItem[] | null }>;
	'edit_file': Promise<{ lintErrors: LintErrorItem[] | null; indentationNote?: string | null }>;
	'create_file_or_folder': {};
	'delete_file_or_folder': {};
	// ---
	'run_command': { result: string; resolveReason: TerminalResolveReason; backgroundId?: string };
	'run_nl_command': { result: string; resolveReason: TerminalResolveReason; parsedCommand: string; explanation: string };
	'run_persistent_command': { result: string; resolveReason: TerminalResolveReason };
	'open_persistent_terminal': { persistentTerminalId: string };
	'kill_persistent_terminal': {};
	'kill_background_command': { killed: boolean; backgroundId: string };
	'read_background_output': { backgroundId: string; output: string; isRunning: boolean };
	// ---
	'web_search': { results: Array<{ title: string; snippet: string; url: string }> };
	'browse_url': { content: string; title?: string; url: string; metadata?: { publishedDate?: string } };
	// ---
	'vibe_complete': { summary: string };
};


export type ToolCallParams<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolCallParams[T] : RawToolParamsObj;
export type ToolResult<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolResultType[T] : RawMCPToolCall;

export type BuiltinToolName = keyof BuiltinToolResultType;

// Param-name set for a built-in tool — derived from the snake-cased call-params
// shape rather than from `typeof builtinTools` to avoid importing the runtime
// `builtinTools` value (which now lives behind a registry and would form a
// cycle through prompt/tools/index.ts).
type BuiltinToolParamNameOfTool<T extends BuiltinToolName> = keyof SnakeCaseKeys<BuiltinToolCallParams[T]>;
export type BuiltinToolParamName = { [T in BuiltinToolName]: BuiltinToolParamNameOfTool<T> }[BuiltinToolName];


export type ToolName = BuiltinToolName | (string & {});
export type ToolParamName<T extends ToolName> = T extends BuiltinToolName ? BuiltinToolParamNameOfTool<T> : string;
