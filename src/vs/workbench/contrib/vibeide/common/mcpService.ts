/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { MCPServerOfName, MCPToolCallParams, RawMCPToolCall } from './mcpServiceTypes.js';
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

	/** Config Guard findings from the last load of `mcp.json` (empty if disabled/clean). */
	getLastGuardFindings(): readonly ConfigGuardFinding[];
}

export const IMCPService = createDecorator<IMCPService>('mcpConfigService');
