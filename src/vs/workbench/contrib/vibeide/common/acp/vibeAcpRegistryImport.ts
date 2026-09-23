/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Adding and updating external agents from the ACP Registry — the contract.
 *
 * It lives in `common/` and the implementation in `electron-browser/`: installing a binary goes to the
 * main process through `IMainProcessService`, which the common layer may not touch. Consumers — the
 * «Внешние агенты» pane among them — depend on this contract, not on the desktop module.
 */

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

export const IVibeAcpRegistryImportService = createDecorator<IVibeAcpRegistryImportService>('vibeAcpRegistryImportService');

export const VIBE_ACP_ADD_FROM_REGISTRY_COMMAND_ID = 'vibeide.externalAgents.addFromRegistry';
export const VIBE_ACP_UPDATE_FROM_REGISTRY_COMMAND_ID = 'vibeide.externalAgents.updateFromRegistry';

/** A newer version in the registry for an agent that came from it. */
export interface IAcpAgentUpdate {
	readonly from: string;
	readonly to: string;
}

export interface IVibeAcpRegistryImportService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeUpdates: Event<void>;

	/** Newer registry versions by agent id — only for entries that came from the registry. */
	readonly updates: ReadonlyMap<string, IAcpAgentUpdate>;

	/** Read the registry (cached for a while) and recompute `updates`. Never asks the person anything. */
	checkUpdates(): Promise<void>;

	/** Pick an agent from the registry, confirm what will run or be downloaded, write the entry. */
	addFromRegistry(): Promise<void>;

	/** Move one registry agent to the registry's current version, after the person confirms. */
	update(agentId: string): Promise<void>;
}
