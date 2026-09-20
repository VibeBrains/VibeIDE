/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { AcpMcpExportResult } from './acp/acpMcpExport.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { MCPServerOfName, MCPToolCallParams, RawMCPToolCall } from './mcpServiceTypes.js';
import { MCP } from '../../mcp/common/modelContextProtocol.js';
import { MemoryProjectAnswer } from './vibeMemoryProject.js';
import { InternalToolInfo } from './prompt/prompts.js';
import { ConfigGuardFinding } from './vibeConfigGuard.js';

// Реализация — `electron-browser/mcpService.ts`: класс говорит с main-процессом по каналу
// `vibe-channel-mcp` через `IMainProcessService`, запрещённый и в `common/**`, и в `browser/**`.
// Контракт остаётся здесь — его берут три потребителя из `browser/` (chatThreadService,
// vibeConfigGuardDiagnosticContribution, vibeMCPTokenRotationContribution).

export type MCPServiceState = {
	mcpServerOfName: MCPServerOfName;
	error: string | undefined; // global parsing error
};

export interface IMCPService {
	readonly _serviceBrand: undefined;
	revealMCPConfigFile(): Promise<void>;
	toggleServerIsOn(serverName: string, isOn: boolean): Promise<void>;

	readonly state: MCPServiceState; // NOT persisted
	onDidChangeState: Event<void>;

	getMCPTools(): InternalToolInfo[] | undefined;
	callMCPTool(toolData: MCPToolCallParams): Promise<{ result: RawMCPToolCall }>;
	stringifyResult(result: RawMCPToolCall): string;

	/**
	 * VibeMemory project of a workspace folder, asked of the memory server's `project_resolve`.
	 * Undefined when the server is absent, lacks the tool, or does not answer in time.
	 */
	resolveMemoryProject(folder: string): Promise<MemoryProjectAnswer | undefined>;

	/** MCP Apps: the `ui://` resource a tool's result renders, or undefined when apps are off or the tool has none. */
	getAppResourceUri(serverName: string, modelToolName: string): string | undefined;
	/** MCP Apps: `resources/read` on the app's own server. */
	readAppResource(serverName: string, uri: string): Promise<MCP.ReadResourceResult>;
	/** MCP Apps: `tools/call` from an app — only a tool of the same server whose visibility includes `app`. */
	callToolFromApp(serverName: string, toolName: string, args: Record<string, unknown>): Promise<MCP.CallToolResult>;

	/**
	 * Серверы для гостевого ACP-агента — поимённо, с причинами пропусков.
	 *
	 * Живёт здесь, а не в реестре агентов: `mcp.json` разбирается ровно один раз, и второй разбор разошёлся бы с
	 * первым молча. Правила отбора чистые — `acpMcpExport.ts`.
	 */
	getAcpMcpServers(names: readonly string[]): AcpMcpExportResult;

	/** Config Guard findings from the last load of `mcp.json` (empty if disabled/clean). */
	getLastGuardFindings(): readonly ConfigGuardFinding[];
}

export const IMCPService = createDecorator<IMCPService>('mcpConfigService');
