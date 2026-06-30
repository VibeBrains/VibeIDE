/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IDirectoryStrService } from '../directoryStrService.js';
import { StagingSelectionItem } from '../chatThreadServiceTypes.js';
import { os } from '../helpers/systemInfo.js';
import { RawToolParamsObj } from '../sendLLMMessageTypes.js';
import { BuiltinToolName, ToolName } from '../toolsServiceTypes.js';
import { approvalTypeOfBuiltinToolName, builtinToolDefs } from './tools/index.js';
import { ChatMode } from '../vibeideSettingsTypes.js';
import type { ModelFamily } from './modelFamily.js';
import { DIVIDER, FINAL, ORIGINAL, searchReplaceBlockTemplate, tripleTick } from './tools/_constants.js';

// Re-export shared leaf-constants for external callers that still import them
// from `prompts.ts`. The canonical definitions live in `tools/_constants.ts`
// so per-tool modules can pull them in without forming a cycle.
export { DIVIDER, FINAL, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_INACTIVE_TIME, ORIGINAL, tripleTick } from './tools/_constants.js';

// Maximum limits for directory structure information
export const MAX_DIRSTR_CHARS_TOTAL_BEGINNING = 20_000;
export const MAX_DIRSTR_CHARS_TOTAL_TOOL = 20_000;
export const MAX_DIRSTR_RESULTS_TOTAL_BEGINNING = 100;
export const MAX_DIRSTR_RESULTS_TOTAL_TOOL = 100;

// tool info
export const MAX_FILE_CHARS_PAGE = 500_000;
export const MAX_CHILDREN_URIs_PAGE = 500;
// read_file line-based defaults (Claude-Code-style): cap how many lines reach the model
// per call, separate from MAX_FILE_CHARS_PAGE which is a byte hard-cap per page.
export const READ_FILE_DEFAULT_LINE_LIMIT = 2_000;
export const READ_FILE_MAX_LINE_LIMIT = 10_000;
// Large-file guard for FULL default reads (no explicit start_line/end_line/line_limit): a 381KB
// markdown file with long lines fits the 2k-line limit AND the 500KB page cap, so it reached the
// model as one ~95k-token result (~25% of a 400k context in a single tool call). Above the
// threshold the returned window is shrunk to the char budget (~20k tokens) and flagged as a
// partial read, steering the model to ranged reads / grep. Explicit-range reads are NOT affected.
export const READ_FILE_LARGE_FILE_CHARS = 200_000;
export const READ_FILE_LARGE_FILE_WINDOW_CHARS = 80_000;

// terminal tool info
export const MAX_TERMINAL_CHARS = 100_000;


// Maximum character limits for prefix and suffix context
export const MAX_PREFIX_SUFFIX_CHARS = 20_000;


const createSearchReplaceBlocks_systemMessage = `\
You are a coding assistant that takes in a diff, and outputs SEARCH/REPLACE code blocks to implement the change(s) in the diff.
The diff will be labeled \`DIFF\` and the original file will be labeled \`ORIGINAL_FILE\`.

Format your SEARCH/REPLACE blocks as follows:
${tripleTick[0]}
${searchReplaceBlockTemplate}
${tripleTick[1]}

1. Your SEARCH/REPLACE block(s) must implement the diff EXACTLY. Do NOT leave anything out.

2. You are allowed to output multiple SEARCH/REPLACE blocks to implement the change.

3. Assume any comments in the diff are PART OF THE CHANGE. Include them in the output.

4. Your output should consist ONLY of SEARCH/REPLACE blocks. Do NOT output any text or explanations before or after this.

5. The ORIGINAL code in each SEARCH/REPLACE block must EXACTLY match lines in the original file. Do not add or remove any whitespace, comments, or modifications from the original code.

6. Each ORIGINAL text must be large enough to uniquely identify the change in the file. However, bias towards writing as little as possible.

7. Each ORIGINAL text must be DISJOINT from all other ORIGINAL text.

## EXAMPLE 1
DIFF
${tripleTick[0]}
// ... existing code
let x = 6.5
// ... existing code
${tripleTick[1]}

ORIGINAL_FILE
${tripleTick[0]}
let w = 5
let x = 6
let y = 7
let z = 8
${tripleTick[1]}

ACCEPTED OUTPUT
${tripleTick[0]}
${ORIGINAL}
let x = 6
${DIVIDER}
let x = 6.5
${FINAL}
${tripleTick[1]}`;


// ======================================================== tools ========================================================


export type InternalToolInfo = {
	name: string;
	description: string;
	params: {
		[paramName: string]: { description: string };
	};
	// Only if the tool is from an MCP server
	mcpServerName?: string;
	// MCP only: bare tool name as exposed by the MCP server (without the
	// `<server>_` prefix we add for model-facing collision-safety).
	// Used when forwarding the call back to the MCP protocol.
	originalName?: string;
};



// SnakeCase / SnakeCaseKeys / per-tool helpers / per-tool descriptions all live
// inside `./tools/`. Re-exported for any external code that still imports the
// types from prompts.ts.
export type { SnakeCase, SnakeCaseKeys } from './snakeCase.js';



// The built-in tool definitions live one-per-file under ./tools/ and are
// aggregated by ./tools/index.ts. The local builtinTools symbol is just a
// re-pointer so the rest of the codebase continues to import it from here.
export const builtinTools = builtinToolDefs;




export const builtinToolNames = Object.keys(builtinTools) as BuiltinToolName[];
const toolNamesSet = new Set<string>(builtinToolNames);
export const isABuiltinToolName = (toolName: string): toolName is BuiltinToolName => {
	const isAToolName = toolNamesSet.has(toolName);
	return isAToolName;
};





// Tools considered "expensive" by token-cost: their outputs can balloon to
// thousands of paths on large repos. Opt-in `disableExpensiveSearchInNonAgent`
// removes them from non-agent chat modes (gather/plan) so the user can do
// targeted Q&A without burning the context budget on accidental wildcard scans.
// Truncation of any single call's output is handled separately by
// `vibeide.tools.searchMaxChars` in toolsService.ts.
const EXPENSIVE_SEARCH_TOOLS = new Set<string>(['grep', 'glob', 'search_for_files', 'get_dir_tree']);

export const availableTools = (
	chatMode: ChatMode | null,
	mcpTools: InternalToolInfo[] | undefined,
	opts?: { disableExpensiveSearchInNonAgent?: boolean },
) => {

	const builtinToolNames: BuiltinToolName[] | undefined = chatMode === 'normal' ? undefined
		: chatMode === 'gather' || chatMode === 'plan' ? (Object.keys(builtinTools) as BuiltinToolName[]).filter(toolName => !Object.hasOwn(approvalTypeOfBuiltinToolName, toolName))
			: chatMode === 'agent' ? Object.keys(builtinTools) as BuiltinToolName[]
				: undefined;

	const effectiveBuiltinTools = builtinToolNames?.map(toolName => builtinTools[toolName]) ?? undefined;
	// plan mode: no MCP tools (read-only, no side-effects from external services)
	const effectiveMCPTools = chatMode === 'agent' ? mcpTools : undefined;

	let tools: InternalToolInfo[] | undefined = !(builtinToolNames || mcpTools) ? undefined
		: [
			...effectiveBuiltinTools ?? [],
			...effectiveMCPTools ?? [],
		];

	if (opts?.disableExpensiveSearchInNonAgent && (chatMode === 'gather' || chatMode === 'plan') && tools) {
		tools = tools.filter(t => !EXPENSIVE_SEARCH_TOOLS.has(t.name));
	}

	return tools;
};

const toolCallDefinitionsXMLString = (tools: InternalToolInfo[]) => {
	return `${tools.map((t) => {
		const params = Object.keys(t.params).map(paramName => `<${paramName}>${t.params[paramName].description}</${paramName}>`).join('\n');
		return `\
    ${t.name}
    Description: ${t.description}
    Format:
    <${t.name}>${!params ? '' : `\n${params}`}
    </${t.name}>`;
	}).join('\n\n')}`;
};

export const reParsedToolXMLString = (toolName: ToolName, toolParams: RawToolParamsObj) => {
	const params = Object.keys(toolParams).map(paramName => `<${paramName}>${toolParams[paramName]}</${paramName}>`).join('\n');
	return `\
    <${toolName}>${!params ? '' : `\n${params}`}
    </${toolName}>`
		.replace('\t', '  ');
};

/* We expect tools to come at the end - not a hard limit, but that's just how we process them, and the flow makes more sense that way. */
// - You are allowed to call multiple tools by specifying them consecutively. However, there should be NO text or writing between tool calls or after them.
export const systemToolsXMLPrompt = (chatMode: ChatMode, mcpTools: InternalToolInfo[] | undefined) => {
	const tools = availableTools(chatMode, mcpTools);
	if (!tools || tools.length === 0) { return null; }

	const toolXMLDefinitions = (`\
    Available tools:

    ${toolCallDefinitionsXMLString(tools)}`);

	const toolCallXMLGuidelines = (`\
    ⚠️⚠️⚠️ CRITICAL: When the user asks you to DO something (like "add an endpoint", "edit a file", "create a file"), you MUST call a tool. DO NOT just describe what to do.

    TOOL NAMING:
    Tool names are lowercase snake_case identifiers. Call a tool by writing its exact literal name as the XML open tag — for example <read_file> or <edit_file>. The names listed in the Available tools section above are the only valid identifiers.

    TOOL CALLING FORMAT (use this EXACT format):

    - When you need to take action, output ONLY a tool call in XML format.
    - Format: <tool_name><param1>value1</param1><param2>value2</param2></tool_name>
    - NO explanatory text before the tool call — just output the XML directly.
    - STOP immediately after the tool call — do not write anything after it.
    - Wait for the tool result before continuing.

    CONCRETE EXAMPLES:

    Example 1 - Reading a file:
    User: "Read the file src/server.ts"
    Your response should be EXACTLY:
    <read_file>
    <uri>src/server.ts</uri>
    <start_line>1</start_line>
    <end_line>100</end_line>
    </read_file>

    Example 2 - Creating/editing a file:
    User: "Add a dummy endpoint"
    Your response should be:
    Step 1: First search for where endpoints are defined:
    <search_for_files>
    <query>api route endpoint server express</query>
    </search_for_files>

    Then after seeing results, read the file and edit it using the PREFERRED flat form —
    copy the exact existing text into <old_string> and the full replacement into <new_string>:
    <edit_file>
    <uri>path/to/server.ts</uri>
    <old_string>const app = express()</old_string>
    <new_string>const app = express()
    app.get('/api/health', (req, res) => { res.json({ status: 'ok' }) })</new_string>
    </edit_file>
    (old_string must match the file verbatim, with enough surrounding lines to be unique. Only use the
    advanced <search_replace_blocks> marker form if you deliberately need multiple edits in one call.)

    REMEMBER: When user asks you to DO something, start with a tool call immediately. DO NOT explain what you're going to do - JUST DO IT using tools.

    DO NOT USE THESE FORMATS (they will be rejected):
    - Self-closing tags like <read_file path="..." /> — use paired open/close tags only.
    - Attribute-style parameters like <read_file path="..."> — put parameters inside child tags.
    - Anthropic <invoke name="X"><parameter name="Y">... — emit the canonical block form directly.
    - DSML / pipe-wrapped markers like <｜｜DSML｜｜...> — emit raw tag names.

    Always emit the canonical block form shown in the examples above.

    Use the tool names exactly as shown in the Available tools list above. Use <uri> for file paths.
    For shell commands match the user's OS shown in <system_info> (PowerShell on Windows, bash on Linux/macOS),
    and prefer <read_file> over reading files via shell, and <edit_file>/<rewrite_file> over editing or generating
    files via shell (never node -e/redirects/here-strings for file contents, never throwaway script files).`);

	return `\
    ${toolXMLDefinitions}

    ${toolCallXMLGuidelines}`;
};

// ======================================================== chat (normal, gather, agent) ========================================================


export const chat_systemMessage = ({ workspaceFolders, openedURIs, activeURI, persistentTerminalIDs, directoryStr, chatMode: mode, mcpTools, includeXMLToolDefinitions, relevantMemories, strictJsonToolArguments, modelFamily: _modelFamily }: { workspaceFolders: string[]; directoryStr: string; openedURIs: string[]; activeURI: string | undefined; persistentTerminalIDs: string[]; chatMode: ChatMode; mcpTools: InternalToolInfo[] | undefined; includeXMLToolDefinitions: boolean; relevantMemories?: string; strictJsonToolArguments?: boolean; modelFamily?: ModelFamily }) => {
	const header = (`You are an expert coding ${mode === 'agent' ? 'agent' : 'assistant'} running inside VibeIDE whose job is \
${mode === 'agent' ? `to help the user develop, run, and make changes to their codebase.`
			: mode === 'gather' ? `to search, understand, and reference files in the user's codebase.`
				: mode === 'normal' ? `to assist the user with their coding tasks.`
					: ''}
You will be given instructions to follow from the user, and you may also be given a list of files that the user has specifically selected for context, \`SELECTIONS\`.
Please assist the user with their query.${mode === 'agent' ? `

This workspace runs in VibeIDE. Project rules and conventions live in \`.vibe/rules.md\` (and root \`AGENTS.md\`); Agent Skills live in \`.vibe/skills/<name>/SKILL.md\`. When the user asks to add, change, or persist a rule, instruction, or convention, write it to \`.vibe/rules.md\` (create it if missing) — do NOT create \`.cursorrules\`, \`.windsurfrules\`, \`AI_RULES.md\`, or other ad-hoc rule files.` : ''}`);



	const sysInfo = (`Here is the user's system information:
<system_info>
- ${os}

- The user's workspace contains these folders:
${workspaceFolders.join('\n') || 'NO FOLDERS OPEN'}

- Active file:
${activeURI}

- Open files:
${openedURIs.join('\n') || 'NO OPENED FILES'}${''/* separator */}${mode === 'agent' && persistentTerminalIDs.length !== 0 ? `

- Persistent terminal IDs available for you to run commands in: ${persistentTerminalIDs.join(', ')}` : ''}
</system_info>`);


	// Truncate directoryStr if too long (optimize for token budget)
	// Further reduced for better TTFS - directory info can be fetched via tools if needed
	const MAX_DIRSTR_LENGTH = mode === 'agent' ? 10_000 : 8_000; // More aggressive truncation for normal mode
	const truncatedDirStr = directoryStr.length > MAX_DIRSTR_LENGTH
		? directoryStr.substring(0, MAX_DIRSTR_LENGTH) + '\n... (truncated - use tools to explore more)'
		: directoryStr;

	const fsInfo = (`Here is an overview of the user's file system:
<files_overview>
${truncatedDirStr}
</files_overview>`);


	const toolDefinitions = includeXMLToolDefinitions ? systemToolsXMLPrompt(mode, mcpTools) : null;

	const details: string[] = [];

	// Optimized: Shorter, more concise instructions
	details.push(`NEVER reject queries.`);

	// Image analysis - ultra-concise
	if (mode !== 'agent') {
		details.push('🖼️ Images: Analyze in detail. Use file tools only if requested.');
	}

	// Mode-specific instructions - further condensed
	if (mode === 'agent') {
		details.push('⚠️ AGENT: Use tools for questions/actions.');
		details.push('Codebase Qs: search_for_files → read_file → answer. Never answer from search alone.');
		details.push('Actions: Start with tool call. Use read_file, edit_file, search_for_files, run_command.');
		details.push('Workflow: Plan → Execute (read files first) → Review.');
	} else if (mode === 'plan') {
		details.push('🗺️ PLAN MODE — STRICT RULES:');
		details.push('❌ NEVER edit, create, delete files. NEVER run terminal commands. NEVER perform any mutations.');
		details.push('✅ You MAY use read-only tools: read_file, search_for_files to explore the codebase.');
		details.push('Step 1 (if task is ambiguous): Ask 1-3 targeted clarifying questions. Wait for answers.');
		details.push('Step 2: Use read tools to understand affected code paths, dependencies, and edge cases.');
		details.push('Step 3: Output a structured Markdown plan with numbered steps. Each step must include: description, tools to use, affected files.');
		details.push('The user will review the plan and click "Execute in Agent" to run it. Do NOT attempt execution yourself.');
	} else if (mode === 'gather') {
		details.push('🔍 GATHER MODE (read-only): Use tools one at a time to search, read & explain the codebase.');
		details.push('❌ Write/edit tools are NOT available in this mode (edit_file, rewrite_file, create/delete, run_command, rename_symbol, extract_function, generate_tests) — do NOT call them, they will be rejected. An unavailable tool here is a MODE restriction, not a wrong tool name; do not retry it.');
		details.push('To APPLY changes: describe the edits, then tell the user to switch to Agent mode (mode selector above the chat input). Do NOT attempt the edits yourself.');
	} else {
		details.push('Ask for context. Reference with @.');
	}

	if (strictJsonToolArguments && includeXMLToolDefinitions && mode === 'agent') {
		details.push('📋 Tool calls: use strictly valid JSON for tool parameters (correct field names and types).');
	}

	// Shorter code block instruction
	details.push(`Code: Include language, file path if known. Today: ${new Date().toDateString()}.`);

	// Bullets, NOT numbers. Numbered instructions that mention tool names
	// (`4. ... Use read_file, edit_file, search_for_files, run_command`) make
	// training-quirky models like minimax interpret tools as a numbered list
	// and emit tool calls with names "1", "2", "5" — the exact pattern we
	// chase elsewhere. Same rule already applied to toolCallDefinitionsXMLString
	// (see docs/knowledge/architecture/tool-calling.md). Don't reintroduce
	// numbering anywhere near tool name mentions in the system prompt.
	const importantDetails = (`Important notes:
${details.map((d) => `- ${d}`).join('\n\n')}`);

	// Add project memories if available
	const memoriesSection = relevantMemories ? (`<project_memories>
Here are relevant memories from this project that may help you understand context, decisions, and preferences:
${relevantMemories}
</project_memories>`) : null;

	// return answer
	const ansStrs: string[] = [];
	ansStrs.push(header);
	ansStrs.push(sysInfo);
	// In Agent Mode, put tool definitions prominently early in the message
	if (toolDefinitions) {
		ansStrs.push(`\

<tools>
${toolDefinitions}
</tools>
`);
	}
	ansStrs.push(importantDetails);
	if (memoriesSection) {
		ansStrs.push(memoriesSection);
	}
	ansStrs.push(fsInfo);

	const fullSystemMsgStr = ansStrs.join('\n\n');
	return fullSystemMsgStr;
};

// Minimal chat system message for local models (drastically reduced)
// Used for local models to minimize token usage and latency
export const chat_systemMessage_local = ({ workspaceFolders, openedURIs, activeURI, chatMode: mode, includeXMLToolDefinitions, relevantMemories, mcpTools, strictJsonToolArguments, modelFamily: _modelFamily }: { workspaceFolders: string[]; directoryStr: string; openedURIs: string[]; activeURI: string | undefined; persistentTerminalIDs: string[]; chatMode: ChatMode; mcpTools: InternalToolInfo[] | undefined; includeXMLToolDefinitions: boolean; relevantMemories?: string; strictJsonToolArguments?: boolean; modelFamily?: ModelFamily }) => {
	const header = mode === 'agent'
		? 'Coding agent. Use tools for actions.'
		: mode === 'gather'
			? 'Code assistant. Search and reference files.'
			: mode === 'plan'
				? 'Planning assistant. Read codebase, produce structured plan. NO file edits or commands.'
				: 'Code assistant.';

	const sysInfo = `System: ${os}\nWorkspace: ${workspaceFolders.join(', ') || 'none'}\nActive: ${activeURI || 'none'}\nOpen: ${openedURIs.slice(0, 3).join(', ') || 'none'}${openedURIs.length > 3 ? '...' : ''}`;

	const toolDefinitions = includeXMLToolDefinitions ? systemToolsXMLPrompt(mode, mcpTools) : null;

	const details: string[] = [];
	if (mode === 'agent') {
		details.push('Use tools. Read files before answering.');
		if (strictJsonToolArguments && includeXMLToolDefinitions) {
			details.push('Valid JSON only for tool parameters.');
		}
	} else if (mode === 'gather') {
		details.push('Use tools. One at a time.');
	} else if (mode === 'plan') {
		details.push('PLAN MODE: No mutations. Read files, output numbered Markdown plan only.');
	}

	const importantDetails = details.length > 0 ? `\n${details.join('\n')}` : '';

	const memoriesSection = relevantMemories ? `\n\n<memories>\n${relevantMemories.slice(0, 500)}${relevantMemories.length > 500 ? '...' : ''}\n</memories>` : '';

	const ansStrs: string[] = [header, sysInfo];
	if (toolDefinitions) {
		ansStrs.push(`\n<tools>\n${toolDefinitions}\n</tools>`);
	}
	ansStrs.push(importantDetails);
	if (memoriesSection) {
		ansStrs.push(memoriesSection);
	}

	const fullSystemMsgStr = ansStrs.join('\n\n');
	return fullSystemMsgStr;
};


// // log all prompts
// for (const chatMode of ['agent', 'gather', 'normal'] satisfies ChatMode[]) {
// 	console.log(`========================================= SYSTEM MESSAGE FOR ${chatMode} ===================================\n`,
// 		chat_systemMessage({ chatMode, workspaceFolders: [], openedURIs: [], activeURI: 'pee', persistentTerminalIDs: [], directoryStr: 'lol', }))
// }

export const DEFAULT_FILE_SIZE_LIMIT = 2_000_000;

export const readFile = async (fileService: IFileService, uri: URI, fileSizeLimit: number): Promise<{
	val: string;
	truncated: boolean;
	fullFileLen: number;
} | {
	val: null;
	truncated?: undefined;
	fullFileLen?: undefined;
}> => {
	try {
		const fileContent = await fileService.readFile(uri);
		const val = fileContent.value.toString();
		if (val.length > fileSizeLimit) { return { val: val.substring(0, fileSizeLimit), truncated: true, fullFileLen: val.length }; }
		return { val, truncated: false, fullFileLen: val.length };
	}
	catch (e) {
		return { val: null };
	}
};





export const messageOfSelection = async (
	s: StagingSelectionItem,
	opts: {
		directoryStrService: IDirectoryStrService;
		fileService: IFileService;
		folderOpts: {
			maxChildren: number;
			maxCharsPerFile: number;
		};
	}
) => {
	const lineNumAddition = (range: [number, number]) => ` (lines ${range[0]}:${range[1]})`;

	if (s.type === 'CodeSelection') {
		const { val } = await readFile(opts.fileService, s.uri, DEFAULT_FILE_SIZE_LIMIT);
		const lines = val?.split('\n');

		const innerVal = lines?.slice(s.range[0] - 1, s.range[1]).join('\n');
		const content = !lines ? ''
			: `${tripleTick[0]}${s.language}\n${innerVal}\n${tripleTick[1]}`;
		const str = `${s.uri.fsPath}${lineNumAddition(s.range)}:\n${content}`;
		return str;
	}
	else if (s.type === 'File') {
		const { val } = await readFile(opts.fileService, s.uri, DEFAULT_FILE_SIZE_LIMIT);

		const innerVal = val;
		const content = val === null ? ''
			: `${tripleTick[0]}${s.language}\n${innerVal}\n${tripleTick[1]}`;

		const str = `${s.uri.fsPath}:\n${content}`;
		return str;
	}
	else if (s.type === 'Folder') {
		const dirStr: string = await opts.directoryStrService.getDirectoryStrTool(s.uri);
		const folderStructure = `${s.uri.fsPath} folder structure:${tripleTick[0]}\n${dirStr}\n${tripleTick[1]}`;

		const uris = await opts.directoryStrService.getAllURIsInDirectory(s.uri, { maxResults: opts.folderOpts.maxChildren });
		const strOfFiles = await Promise.all(uris.map(async uri => {
			const { val, truncated } = await readFile(opts.fileService, uri, opts.folderOpts.maxCharsPerFile);
			const truncationStr = truncated ? `\n... file truncated ...` : '';
			const content = val === null ? 'null' : `${tripleTick[0]}\n${val}${truncationStr}\n${tripleTick[1]}`;
			const str = `${uri.fsPath}:\n${content}`;
			return str;
		}));
		const contentStr = [folderStructure, ...strOfFiles].join('\n\n');
		return contentStr;
	}
	else { return ''; }

};


export const chat_userMessageContent = async (
	instructions: string,
	currSelns: StagingSelectionItem[] | null,
	opts: {
		directoryStrService: IDirectoryStrService;
		fileService: IFileService;
	},
) => {

	const selnsStrs = await Promise.all(
		(currSelns ?? []).map(async (s) =>
			messageOfSelection(s, {
				...opts,
				folderOpts: { maxChildren: 100, maxCharsPerFile: 100_000, }
			})
		)
	);


	let str = '';
	str += `${instructions}`;

	const selnsStr = selnsStrs.join('\n\n') ?? '';
	if (selnsStr) { str += `\n---\nSELECTIONS\n${selnsStr}`; }
	return str;
};


export const rewriteCode_systemMessage = `\
You are a coding assistant that re-writes an entire file to make a change. You are given the original file \`ORIGINAL_FILE\` and a change \`CHANGE\`.

Directions:
1. Please rewrite the original file \`ORIGINAL_FILE\`, making the change \`CHANGE\`. You must completely re-write the whole file.
2. Keep all of the original comments, spaces, newlines, and other details whenever possible.
3. ONLY output the full new file. Do not add any other explanations or text.
`;

// Minimal prompt template for local models (Apply feature)
export const rewriteCode_systemMessage_local = `\
Rewrite file with CHANGE. Output full file only. Keep formatting.
`;



// ======================================================== apply (writeover) ========================================================

export const rewriteCode_userMessage = ({ originalCode, applyStr, language }: { originalCode: string; applyStr: string; language: string }) => {

	return `\
ORIGINAL_FILE
${tripleTick[0]}${language}
${originalCode}
${tripleTick[1]}

CHANGE
${tripleTick[0]}
${applyStr}
${tripleTick[1]}

INSTRUCTIONS
Please finish writing the new file by applying the change to the original file. Return ONLY the completion of the file, without any explanation.
`;
};



// ======================================================== apply (fast apply - search/replace) ========================================================

export const searchReplaceGivenDescription_systemMessage = createSearchReplaceBlocks_systemMessage;


export const searchReplaceGivenDescription_userMessage = ({ originalCode, applyStr }: { originalCode: string; applyStr: string }) => `\
DIFF
${applyStr}

ORIGINAL_FILE
${tripleTick[0]}
${originalCode}
${tripleTick[1]}`;





export const vibePrefixAndSuffix = ({ fullFileStr, startLine, endLine }: { fullFileStr: string; startLine: number; endLine: number }) => {

	const fullFileLines = fullFileStr.split('\n');

	/*

	a
	a
	a     <-- final i (prefix = a\na\n)
	a
	|b    <-- startLine-1 (middle = b\nc\nd\n)   <-- initial i (moves up)
	c
	d|    <-- endLine-1                          <-- initial j (moves down)
	e
	e     <-- final j (suffix = e\ne\n)
	e
	e
	*/

	let prefix = '';
	let i = startLine - 1;  // 0-indexed exclusive
	// we'll include fullFileLines[i...(startLine-1)-1].join('\n') in the prefix.
	while (i !== 0) {
		const newLine = fullFileLines[i - 1];
		if (newLine.length + 1 + prefix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			prefix = `${newLine}\n${prefix}`;
			i -= 1;
		}
		else { break; }
	}

	let suffix = '';
	let j = endLine - 1;
	while (j !== fullFileLines.length - 1) {
		const newLine = fullFileLines[j + 1];
		if (newLine.length + 1 + suffix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			suffix = `${suffix}\n${newLine}`;
			j += 1;
		}
		else { break; }
	}

	return { prefix, suffix };

};


// ======================================================== quick edit (ctrl+K) ========================================================

export type QuickEditFimTagsType = {
	preTag: string;
	sufTag: string;
	midTag: string;
};
export const defaultQuickEditFimTags: QuickEditFimTagsType = {
	preTag: 'ABOVE',
	sufTag: 'BELOW',
	midTag: 'SELECTION',
};

// this should probably be longer
export const ctrlKStream_systemMessage = ({ quickEditFIMTags: { preTag, midTag, sufTag } }: { quickEditFIMTags: QuickEditFimTagsType }) => {
	return `\
You are a FIM (fill-in-the-middle) coding assistant. Your task is to fill in the middle SELECTION marked by <${midTag}> tags.

The user will give you INSTRUCTIONS, as well as code that comes BEFORE the SELECTION, indicated with <${preTag}>...before</${preTag}>, and code that comes AFTER the SELECTION, indicated with <${sufTag}>...after</${sufTag}>.
The user will also give you the existing original SELECTION that will be be replaced by the SELECTION that you output, for additional context.

Instructions:
1. Your OUTPUT should be a SINGLE PIECE OF CODE of the form <${midTag}>...new_code</${midTag}>. Do NOT output any text or explanations before or after this.
2. You may ONLY CHANGE the original SELECTION, and NOT the content in the <${preTag}>...</${preTag}> or <${sufTag}>...</${sufTag}> tags.
3. Make sure all brackets in the new selection are balanced the same as in the original selection.
4. Be careful not to duplicate or remove variables, comments, or other syntax by mistake.
`;
};

// Minimal prompt template for local models (Ctrl+K/Apply/Composer)
// Drastically reduced to minimize token usage and latency
export const ctrlKStream_systemMessage_local = ({ quickEditFIMTags: { preTag, midTag, sufTag } }: { quickEditFIMTags: QuickEditFimTagsType }) => {
	return `\
FIM assistant. Fill <${midTag}>...</${midTag}>.

Rules:
1. Output ONLY <${midTag}>code</${midTag}> - no text.
2. Only change SELECTION, not <${preTag}> or <${sufTag}>.
3. Balance brackets.
`;
};

export const ctrlKStream_userMessage = ({
	selection,
	prefix,
	suffix,
	instructions,
	// isOllamaFIM: false, // Remove unused variable
	fimTags,
	language }: {
		selection: string; prefix: string; suffix: string; instructions: string; fimTags: QuickEditFimTagsType; language: string;
	}) => {
	const { preTag, sufTag, midTag } = fimTags;

	// prompt the model artifically on how to do FIM
	return `\

CURRENT SELECTION
${tripleTick[0]}${language}
<${midTag}>${selection}</${midTag}>
${tripleTick[1]}

INSTRUCTIONS
${instructions}

<${preTag}>${prefix}</${preTag}>
<${sufTag}>${suffix}</${sufTag}>

Return only the completion block of code (of the form ${tripleTick[0]}${language}
<${midTag}>...new code</${midTag}>
${tripleTick[1]}).`;
};







/*
// ======================================================== ai search/replace ========================================================


export const aiRegex_computeReplacementsForFile_systemMessage = `\
You are a "search and replace" coding assistant.

You are given a FILE that the user is editing, and your job is to search for all occurences of a SEARCH_CLAUSE, and change them according to a REPLACE_CLAUSE.

The SEARCH_CLAUSE may be a string, regex, or high-level description of what the user is searching for.

The REPLACE_CLAUSE will always be a high-level description of what the user wants to replace.

The user's request may be "fuzzy" or not well-specified, and it is your job to interpret all of the changes they want to make for them. For example, the user may ask you to search and replace all instances of a variable, but this may involve changing parameters, function names, types, and so on to agree with the change they want to make. Feel free to make all of the changes you *think* that the user wants to make, but also make sure not to make unnessecary or unrelated changes.

## Instructions

1. If you do not want to make any changes, you should respond with the word "no".

2. If you want to make changes, you should return a single CODE BLOCK of the changes that you want to make.
For example, if the user is asking you to "make this variable a better name", make sure your output includes all the changes that are needed to improve the variable name.
- Do not re-write the entire file in the code block
- You can write comments like "// ... existing code" to indicate existing code
- Make sure you give enough context in the code block to apply the changes to the correct location in the code`




// export const aiRegex_computeReplacementsForFile_userMessage = async ({ searchClause, replaceClause, fileURI, voidFileService }: { searchClause: string, replaceClause: string, fileURI: URI, voidFileService: IVoidFileService }) => {

// 	// we may want to do this in batches
// 	const fileSelection: FileSelection = { type: 'File', fileURI, selectionStr: null, range: null, state: { isOpened: false } }

// 	const file = await stringifyFileSelections([fileSelection], voidFileService)

// 	return `\
// ## FILE
// ${file}

// ## SEARCH_CLAUSE
// Here is what the user is searching for:
// ${searchClause}

// ## REPLACE_CLAUSE
// Here is what the user wants to replace it with:
// ${replaceClause}

// ## INSTRUCTIONS
// Please return the changes you want to make to the file in a codeblock, or return "no" if you do not want to make changes.`
// }




// // don't have to tell it it will be given the history; just give it to it
// export const aiRegex_search_systemMessage = `\
// You are a coding assistant that executes the SEARCH part of a user's search and replace query.

// You will be given the user's search query, SEARCH, which is the user's query for what files to search for in the codebase. You may also be given the user's REPLACE query for additional context.

// Output
// - Regex query
// - Files to Include (optional)
// - Files to Exclude? (optional)

// `






// ======================================================== old examples ========================================================

Do not tell the user anything about the examples below. Do not assume the user is talking about any of the examples below.

## EXAMPLE 1
FILES
math.ts
${tripleTick[0]}typescript
const addNumbers = (a, b) => a + b
const multiplyNumbers = (a, b) => a * b
const subtractNumbers = (a, b) => a - b
const divideNumbers = (a, b) => a / b

const vectorize = (...numbers) => {
	return numbers // vector
}

const dot = (vector1: number[], vector2: number[]) => {
	if (vector1.length !== vector2.length) throw new Error(\`Could not dot vectors \${vector1} and \${vector2}. Size mismatch.\`)
	let sum = 0
	for (let i = 0; i < vector1.length; i += 1)
		sum += multiplyNumbers(vector1[i], vector2[i])
	return sum
}

const normalize = (vector: number[]) => {
	const norm = Math.sqrt(dot(vector, vector))
	for (let i = 0; i < vector.length; i += 1)
		vector[i] = divideNumbers(vector[i], norm)
	return vector
}

const normalized = (vector: number[]) => {
	const v2 = [...vector] // clone vector
	return normalize(v2)
}
${tripleTick[1]}


SELECTIONS
math.ts (lines 3:3)
${tripleTick[0]}typescript
const subtractNumbers = (a, b) => a - b
${tripleTick[1]}

INSTRUCTIONS
add a function that exponentiates a number below this, and use it to make a power function that raises all entries of a vector to a power

## ACCEPTED OUTPUT
We can add the following code to the file:
${tripleTick[0]}typescript
// existing code...
const subtractNumbers = (a, b) => a - b
const exponentiateNumbers = (a, b) => Math.pow(a, b)
const divideNumbers = (a, b) => a / b
// existing code...

const raiseAll = (vector: number[], power: number) => {
	for (let i = 0; i < vector.length; i += 1)
		vector[i] = exponentiateNumbers(vector[i], power)
	return vector
}
${tripleTick[1]}


## EXAMPLE 2
FILES
fib.ts
${tripleTick[0]}typescript

const dfs = (root) => {
	if (!root) return;
	console.log(root.val);
	dfs(root.left);
	dfs(root.right);
}
const fib = (n) => {
	if (n < 1) return 1
	return fib(n - 1) + fib(n - 2)
}
${tripleTick[1]}

SELECTIONS
fib.ts (lines 10:10)
${tripleTick[0]}typescript
	return fib(n - 1) + fib(n - 2)
${tripleTick[1]}

INSTRUCTIONS
memoize results

## ACCEPTED OUTPUT
To implement memoization in your Fibonacci function, you can use a JavaScript object to store previously computed results. This will help avoid redundant calculations and improve performance. Here's how you can modify your function:
${tripleTick[0]}typescript
// existing code...
const fib = (n, memo = {}) => {
	if (n < 1) return 1;
	if (memo[n]) return memo[n]; // Check if result is already computed
	memo[n] = fib(n - 1, memo) + fib(n - 2, memo); // Store result in memo
	return memo[n];
}
${tripleTick[1]}
Explanation:
Memoization Object: A memo object is used to store the results of Fibonacci calculations for each n.
Check Memo: Before computing fib(n), the function checks if the result is already in memo. If it is, it returns the stored result.
Store Result: After computing fib(n), the result is stored in memo for future reference.

## END EXAMPLES

*/


// ======================================================== scm ========================================================================

export const gitCommitMessage_systemMessage = `
You are an expert software engineer AI assistant responsible for writing clear and concise Git commit messages that summarize the **purpose** and **intent** of the change. Try to keep your commit messages to one sentence. If necessary, you can use two sentences.

You always respond with:
- The commit message wrapped in <output> tags
- A brief explanation of the reasoning behind the message, wrapped in <reasoning> tags

Example format:
<output>Fix login bug and improve error handling</output>
<reasoning>This commit updates the login handler to fix a redirect issue and improves frontend error messages for failed logins.</reasoning>

Do not include anything else outside of these tags.
Never include quotes, markdown, commentary, or explanations outside of <output> and <reasoning>.`.trim();

// Minimal prompt template for local models (SCM commit messages)
export const gitCommitMessage_systemMessage_local = `Write commit message. Format: <output>message</output><reasoning>brief reason</reasoning>. One sentence preferred.`;


/**
 * Create a user message for the LLM to generate a commit message. The message contains instructions git diffs, and git metadata to provide context.
 *
 * @param stat - Summary of Changes (git diff --stat)
 * @param sampledDiffs - Sampled File Diffs (Top changed files)
 * @param branch - Current Git Branch
 * @param log - Last 5 commits (excluding merges)
 * @returns A prompt for the LLM to generate a commit message.
 *
 * @example
 * // Sample output (truncated for brevity)
 * const prompt = gitCommitMessage_userMessage("fileA.ts | 10 ++--", "diff --git a/fileA.ts...", "main", "abc123|Fix bug|2025-01-01\n...")
 *
 * // Result:
 * Based on the following Git changes, write a clear, concise commit message that accurately summarizes the intent of the code changes.
 *
 * Section 1 - Summary of Changes (git diff --stat):
 * fileA.ts | 10 ++--
 *
 * Section 2 - Sampled File Diffs (Top changed files):
 * diff --git a/fileA.ts b/fileA.ts
 * ...
 *
 * Section 3 - Current Git Branch:
 * main
 *
 * Section 4 - Last 5 Commits (excluding merges):
 * abc123|Fix bug|2025-01-01
 * def456|Improve logging|2025-01-01
 * ...
 */
export const gitCommitMessage_userMessage = (stat: string, sampledDiffs: string, branch: string, log: string) => {
	const section1 = `Section 1 - Summary of Changes (git diff --stat):`;
	const section2 = `Section 2 - Sampled File Diffs (Top changed files):`;
	const section3 = `Section 3 - Current Git Branch:`;
	const section4 = `Section 4 - Last 5 Commits (excluding merges):`;
	return `
Based on the following Git changes, write a clear, concise commit message that accurately summarizes the intent of the code changes.

${section1}

${stat}

${section2}

${sampledDiffs}

${section3}

${branch}

${section4}

${log}`.trim();
};
