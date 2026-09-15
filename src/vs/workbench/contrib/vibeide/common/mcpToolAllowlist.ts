/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { MCPConfigFileEntryJSON } from './mcpServiceTypes.js';

/**
 * Whether a server's tool is within the `tools` list of its `mcp.json` entry.
 *
 * WHY a list and not the server's annotations: the MCP spec tells clients to treat tool annotations as
 * untrusted unless the server is trusted, and Microsoft's federated connectors keep «read-only» by
 * certification rather than by filtering. A list the user wrote is the one thing a server cannot rewrite.
 *
 * Absent list — every tool, as before. An empty list — none: the entry is explicit about offering nothing.
 * Names are compared exactly, as the server spells them.
 */
export function isMcpToolAllowedByEntry(entry: Pick<MCPConfigFileEntryJSON, 'tools'> | undefined, toolName: string): boolean {
	const list = entry?.tools;
	if (!Array.isArray(list)) {
		return true;
	}
	return list.some(name => typeof name === 'string' && name === toolName);
}
