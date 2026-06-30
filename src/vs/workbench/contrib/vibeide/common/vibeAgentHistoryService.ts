/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { AuditEvent, IAuditLogService } from './auditLogService.js';

export interface AgentHistoryEntry {
	id: string;
	sessionId: string;
	action: string;
	description: string;
	files: string[];
	timestamp: number;
	canRollback: boolean;
	snapshotId?: string;
	repairChainId?: string; // For repair loop grouping
}

export const IVibeAgentHistoryService = createDecorator<IVibeAgentHistoryService>('vibeAgentHistoryService');

export interface IVibeAgentHistoryService {
	readonly _serviceBrand: undefined;

	/** Record an agent action in current session */
	recordAction(entry: Omit<AgentHistoryEntry, 'id' | 'timestamp'>): void;

	/** Get current session history */
	getCurrentSessionHistory(): AgentHistoryEntry[];

	/** Get history for a specific session */
	getSessionHistory(sessionId: string): AgentHistoryEntry[];

	/** Get all sessions (for "Past sessions" tab) */
	getAllSessions(): string[];

	/** Event: new action recorded */
	readonly onActionRecorded: Event<AgentHistoryEntry>;
}

/**
 * VibeIDE Agent Action History Sidebar data layer.
 * Persistent per-session chronology of agent actions.
 * Enables: rollback any step, replay, explain this decision.
 */
class VibeAgentHistoryService extends Disposable implements IVibeAgentHistoryService {
	declare readonly _serviceBrand: undefined;

	private readonly _onActionRecorded = this._register(new Emitter<AgentHistoryEntry>());
	readonly onActionRecorded = this._onActionRecorded.event;

	private readonly _history = new Map<string, AgentHistoryEntry[]>();
	private _currentSessionId: string;

	constructor(
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
	) {
		super();
		this._currentSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		this._history.set(this._currentSessionId, []);
	}

	recordAction(entry: Omit<AgentHistoryEntry, 'id' | 'timestamp'>): void {
		const full: AgentHistoryEntry = {
			...entry,
			id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			timestamp: Date.now(),
		};

		const sessionHistory = this._history.get(entry.sessionId) ?? [];
		sessionHistory.push(full);
		this._history.set(entry.sessionId, sessionHistory);

		this._onActionRecorded.fire(full);
		vibeLog.debug('AgentHistory', `${entry.action}: ${entry.description.slice(0, 60)}`);

		// Also persist to audit log
		if (this._auditLogService.isEnabled()) {
			this._auditLogService.append({
				ts: full.timestamp,
				action: entry.action as AuditEvent['action'],
				files: entry.files,
				ok: true,
				meta: {
					historyId: full.id,
					sessionId: entry.sessionId,
					description: entry.description,
					snapshotId: entry.snapshotId,
					repairChainId: entry.repairChainId,
				},
			});
		}
	}

	getCurrentSessionHistory(): AgentHistoryEntry[] {
		return this._history.get(this._currentSessionId) ?? [];
	}

	getSessionHistory(sessionId: string): AgentHistoryEntry[] {
		return this._history.get(sessionId) ?? [];
	}

	getAllSessions(): string[] {
		return Array.from(this._history.keys());
	}
}

registerSingleton(IVibeAgentHistoryService, VibeAgentHistoryService, InstantiationType.Eager);
