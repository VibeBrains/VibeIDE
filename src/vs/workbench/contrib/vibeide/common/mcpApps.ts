/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpApps } from '../../../../platform/mcp/common/modelContextProtocolApps.js';
import { MCPTool } from './mcpServiceTypes.js';

/**
 * MCP Apps: pure decisions shared by the main-process client, the renderer service and the host.
 *
 * A tool may carry `_meta.ui` naming a `ui://` resource the host renders next to the tool result, and
 * a visibility list saying who may call it: the model, the app, or both. Everything here is data in,
 * data out, so the rules are tested without a server.
 */

/** Extension id the client announces so servers know UI resources will be rendered. */
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';

/** The only resource MIME type an MCP App may use. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** Client capability block for the MCP SDK `Client` constructor; empty when apps are off. */
export function mcpAppsClientCapabilities(appsEnabled: boolean): { extensions?: Record<string, object> } {
	return appsEnabled ? { extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } } } : {};
}

const DEFAULT_VISIBILITY: readonly McpApps.McpUiToolVisibility[] = ['model', 'app'];

/**
 * UI metadata of a tool. Reads the current `_meta.ui` object and the older flat `_meta["ui/resourceUri"]`
 * key that early servers still send. A resource outside the `ui://` scheme is ignored: the spec reserves
 * that scheme, and anything else would be a URL the host has no business loading.
 */
export function mcpAppUiOfTool(tool: Pick<MCPTool, '_meta'>): { resourceUri: string | undefined; visibility: readonly McpApps.McpUiToolVisibility[] } {
	const meta = tool._meta ?? {};
	const ui = typeof meta.ui === 'object' && meta.ui !== null ? meta.ui as McpApps.McpUiToolMeta : undefined;
	const rawUri = ui?.resourceUri ?? meta['ui/resourceUri'];
	const resourceUri = typeof rawUri === 'string' && rawUri.startsWith('ui://') ? rawUri : undefined;
	const rawVisibility = Array.isArray(ui?.visibility) ? ui.visibility.filter(v => v === 'model' || v === 'app') : undefined;
	return { resourceUri, visibility: rawVisibility ?? DEFAULT_VISIBILITY };
}

/** Tools marked app-only stay out of the model's tool list. */
export function isMcpToolVisibleToModel(tool: Pick<MCPTool, '_meta'>): boolean {
	return mcpAppUiOfTool(tool).visibility.includes('model');
}

/** Whether an app may call this tool of its own server. */
export function isMcpToolCallableByApp(tool: Pick<MCPTool, '_meta'>): boolean {
	return mcpAppUiOfTool(tool).visibility.includes('app');
}

/** Only web links leave an app: other schemes could reach product URL handlers. */
export function isMcpAppLinkAllowed(url: string): boolean {
	try {
		const protocol = new URL(url).protocol;
		return protocol === 'http:' || protocol === 'https:';
	} catch {
		return false;
	}
}

/** Text of a `ui/message` request; non-text blocks are not carried into the chat input. */
export function mcpAppMessageText(content: readonly { type: string; text?: unknown }[]): string {
	return content.filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text as string).join('\n\n');
}
