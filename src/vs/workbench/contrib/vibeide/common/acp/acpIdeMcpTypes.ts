/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { AcpMcpServer } from './acpMcpExport.js';
import { IIdeMcpToolResult } from './acpIdeMcp.js';
import { JsonValue } from './acpProtocol.js';

/**
 * The channel between the window and the main process for the editor's MCP server
 *
 * The socket belongs to the main process, like the agents' processes: one listener per application, whatever the
 * number of windows. The editor — the open file, the selection, the markers — belongs to a window, so a tool call
 * goes from the socket to the window that issued the token and the answer comes back the same way
 */
export const VIBE_ACP_IDE_MCP_CHANNEL = 'vibeide-channel-acpIdeMcp';

/** A tool call waiting for the window that issued the token */
export interface IIdeMcpCall {
	readonly callId: string;
	/** The window instance the call is for; every window hears every call, and only that one answers */
	readonly instanceId: string;
	readonly tool: string;
	readonly args: Record<string, JsonValue>;
}

/** What a window gets for a session: the entry to hand the agent in `session/new`, and the token to withdraw it with */
export interface IIdeMcpIssued {
	readonly token: string;
	readonly server: Extract<AcpMcpServer, { readonly type: 'http' }>;
}

export interface IVibeAcpIdeMcpMain {
	readonly onToolCall: Event<IIdeMcpCall>;
	/** A token for one agent session of this window, and the server entry that carries it */
	issue(windowId: number, instanceId: string): Promise<IIdeMcpIssued>;
	/** The session ended: its token stops working, and the listener closes when no token is left */
	revoke(token: string): Promise<void>;
	/** The window answers a call it was handed */
	completeToolCall(callId: string, result: IIdeMcpToolResult): Promise<void>;
}
