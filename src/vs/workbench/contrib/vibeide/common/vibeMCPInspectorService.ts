/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export interface MCPInspectorEntry {
	id: string;
	timestamp: number;
	serverName: string;
	toolName: string;
	arguments: Record<string, unknown>;
	result?: unknown;
	error?: string;
	durationMs: number;
	executionMode: 'ptc' | 'parallel' | 'sequential';
}

export const IVibeMCPInspectorService = createDecorator<IVibeMCPInspectorService>('vibeMCPInspectorService');

export interface IVibeMCPInspectorService {
	readonly _serviceBrand: undefined;

	/** Record an MCP tool call */
	record(entry: Omit<MCPInspectorEntry, 'id' | 'timestamp'>): void;

	/** Get recent MCP calls */
	getRecent(limit?: number): MCPInspectorEntry[];

	/** Clear inspector log */
	clear(): void;

	readonly onMCPCall: Event<MCPInspectorEntry>;
}

/**
 * VibeIDE MCP Inspector: visual debugger for MCP requests.
 * Records: which server, with what arguments, what response, execution mode.
 * Powers: MCP Inspector panel in IDE (Transparency Suite).
 */
class VibeMCPInspectorService extends Disposable implements IVibeMCPInspectorService {
	declare readonly _serviceBrand: undefined;

	private readonly _onMCPCall = this._register(new Emitter<MCPInspectorEntry>());
	readonly onMCPCall = this._onMCPCall.event;

	private readonly _entries: MCPInspectorEntry[] = [];
	private readonly MAX_ENTRIES = 500;

	constructor(
	) {
		super();
	}

	record(entry: Omit<MCPInspectorEntry, 'id' | 'timestamp'>): void {
		const full: MCPInspectorEntry = {
			...entry,
			id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			timestamp: Date.now(),
		};

		if (this._entries.length >= this.MAX_ENTRIES) {
			this._entries.shift();
		}
		this._entries.push(full);
		this._onMCPCall.fire(full);

		vibeLog.debug('vibeMCPInspector', `[VibeIDE MCP Inspector] ${entry.serverName}.${entry.toolName} [${entry.executionMode}] ${entry.durationMs}ms ${entry.error ? '❌' : '✅'}`);
	}

	getRecent(limit: number = 50): MCPInspectorEntry[] {
		return this._entries.slice(-limit);
	}

	clear(): void {
		this._entries.length = 0;
	}
}

registerSingleton(IVibeMCPInspectorService, VibeMCPInspectorService, InstantiationType.Eager);
