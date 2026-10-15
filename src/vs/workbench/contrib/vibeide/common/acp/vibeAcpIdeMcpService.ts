/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IIdeMcpIssued } from './acpIdeMcpTypes.js';

export const IVibeAcpIdeMcpService = createDecorator<IVibeAcpIdeMcpService>('vibeAcpIdeMcpService');

/**
 * The editor's MCP server for external agents, from the window's side
 * The sessions service asks for an entry before it starts an agent and withdraws it when the session ends;
 * the implementation (`electron-browser/acp`) also answers the tool calls with what this window's editor shows
 */
export interface IVibeAcpIdeMcpService {
	readonly _serviceBrand: undefined;

	/** An entry for the agent's `session/new`, or `undefined` when the person turned the editor tools off */
	issue(): Promise<IIdeMcpIssued | undefined>;
	revoke(token: string): Promise<void>;
}
