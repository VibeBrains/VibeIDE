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
	const fromUri = uri && typeof uri === 'object' && Object.hasOwn(uri, 'fsPath')
		? (uri as { fsPath?: unknown }).fsPath
		: undefined;
	const candidate = fromUri ?? params.path ?? params.dirUri;
	if (typeof candidate !== 'string' || candidate.length === 0) {
		return undefined;
	}
	return candidate.slice(0, MAX_TARGET_LEN);
}

/** Fields for the audit event of a tool call. Arguments never travel; the target path may. */
export function buildToolCallAudit(input: ToolCallAuditInput): ToolCallAuditFields {
	const target = toolCallTargetPath(input);
	const meta: Record<string, unknown> = { tool: input.toolName };
	if (input.mcpServerName) {
		meta.mcpServer = input.mcpServerName;
	}
	return target ? { files: [target], meta } : { meta };
}
