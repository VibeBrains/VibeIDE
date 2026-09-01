/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What goes into the audit log when the agent uses a tool.
 *
 * The audit log already records prompts, replies, applied diffs, plans, subagents and verify-gate
 * outcomes — but not the thing that actually touches the user's machine. Tool calls existed only in
 * the debug trace, which is not retained, not exportable and not covered by the GDPR export/erase
 * pair the audit log implements.
 *
 * **What is deliberately NOT recorded:** command bodies, tool arguments, search queries, file
 * contents. The audit answers "which tool touched what, when, and did it succeed" — a log that also
 * carried arguments would carry secrets sooner or later, and the same decision is already recorded
 * for the agent run ledger. The target path is the one exception, because "which files did the
 * agent touch" is the whole point of an access log.
 */

/** Shell-ish tools whose parameter is a command line rather than a path. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set([
	'run_command',
	'run_persistent_command',
	'kill_background_command',
	// Natural-language shell: its parameter is a request that becomes a command line.
	'run_nl_command',
]);

export interface ToolCallAuditInput {
	readonly toolName: string;
	/** Raw validated params of the call — read for a target path only. */
	readonly params: Readonly<Record<string, unknown>> | undefined;
	/** MCP server the tool came from, when it is not a built-in. */
	readonly mcpServerName?: string;
}

export interface ToolCallAuditFields {
	readonly files?: string[];
	readonly meta: Record<string, unknown>;
}

/** Longest target path kept. Beyond this a path is a payload, not an identifier. */
const MAX_TARGET_LEN = 260;

/**
 * Pull the audit-worthy target out of a tool call: the file or folder it acts on.
 *
 * Returns nothing for command-shaped tools — their "target" is a command line, which is exactly
 * what must not be logged. That the agent ran *a* command is still recorded by the event itself.
 */
export function toolCallTargetPath(input: ToolCallAuditInput): string | undefined {
	if (COMMAND_TOOLS.has(input.toolName)) {
		return undefined;
	}
	const params = input.params;
	if (!params) {
		return undefined;
	}
	const uri = params.uri;
	// `URI.fsPath` is a GETTER ON THE PROTOTYPE, so `Object.hasOwn(uri, 'fsPath')` is false for every
	// real URI — a check written that way silently records no path at all. Read the value and judge
	// by its type instead.
	const fromUri = uri && typeof uri === 'object'
		? (uri as { fsPath?: unknown }).fsPath
		: undefined;
	const candidate = fromUri ?? params.path ?? params.dirUri;
	if (typeof candidate !== 'string' || candidate.length === 0) {
		return undefined;
	}
	return candidate.slice(0, MAX_TARGET_LEN);
}

/** Fields for the audit event of a tool call. Arguments never travel; the target path may. */
/** Tools that change files. Reading `.vibe/` is ordinary work; writing to it is the notable event. */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
	'edit_file',
	'rewrite_file',
	'create_file_or_folder',
	'delete_file_or_folder',
	'write_file',
]);

/**
 * Does this call write into `.vibe/` — the folder shared by every run in the workspace?
 *
 * `.vibe/` holds plans, agent locks, run artifacts and rules: state one run leaves for the next,
 * and therefore a channel between agents, not just a pile of config. In the OpenAI/Hugging Face
 * incident the agents built their message board out of exactly this kind of surface — a shared
 * store nobody was watching as a channel (Artifactory, directories prefixed `zz`, 70k+ messages).
 * We do not forbid these writes: plans and locks are how our own orchestration works. We record
 * them, so that «agents started leaving each other notes» is a question the log can answer.
 *
 * Reads are deliberately not flagged — the agent reads rules and skills from here on every turn,
 * and a flag on that would be noise that trains people to ignore the flag.
 */
export function writesToSharedState(toolName: string, targetPath: string | undefined): boolean {
	if (!targetPath || !WRITE_TOOLS.has(toolName)) {
		return false;
	}
	// Match a path SEGMENT, so `.vibe-defaults/` and `my.vibe/` are not mistaken for it. Both
	// separators are checked because the path arrives as the tool received it, not normalized.
	const normalized = targetPath.replace(/\\/g, '/');
	return normalized === '.vibe' || normalized.startsWith('.vibe/') || normalized.includes('/.vibe/') || normalized.endsWith('/.vibe');
}

export function buildToolCallAudit(input: ToolCallAuditInput): ToolCallAuditFields {
	const target = toolCallTargetPath(input);
	const meta: Record<string, unknown> = { tool: input.toolName };
	if (input.mcpServerName) {
		meta.mcpServer = input.mcpServerName;
	}
	if (writesToSharedState(input.toolName, target)) {
		meta.sharedState = true;
	}
	return target ? { files: [target], meta } : { meta };
}
