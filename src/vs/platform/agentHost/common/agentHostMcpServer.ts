/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpServerState, McpServerStatus } from './state/protocol/state.js';

/**
 * MCP server exposed by an agent host session provider.
 *
 * Upstream declares this in `vs/sessions/common/agentHostSessionsProvider.ts`, which belongs to the
 * Agent Sessions window — a layer VibeIDE does not ship (we have our own external-agent surface).
 * The interface itself carries no session UI, only the shape the chat layer needs, so it lives here
 * next to the rest of the agent host contracts instead of pulling the whole sessions layer back in.
 */
export interface IAgentHostMcpServer {
	readonly id: string;
	readonly name: string;
	readonly enabled: boolean;
	readonly status: McpServerStatus;
	readonly state: McpServerState;
	readonly logOutputChannelId?: string;
	/** Starts or restarts the server. Providers that cannot control lifecycle may no-op. */
	start(): Promise<void>;
	/** Stops the server. Providers that cannot control lifecycle may no-op. */
	stop(): Promise<void>;
	setEnabled(enabled: boolean): void;
}
