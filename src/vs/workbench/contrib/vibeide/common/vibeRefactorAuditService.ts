/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IAuditLogService } from './auditLogService.js';
import { IVibeAgentHistoryService } from './vibeAgentHistoryService.js';

export interface RefactorOperation {
	type: 'rename' | 'move' | 'extract' | 'inline';
	symbol?: string;
	from?: string;
	to?: string;
	affectedFiles: string[];
	totalChanges: number;
}

export const IVibeRefactorAuditService = createDecorator<IVibeRefactorAuditService>('vibeRefactorAuditService');

export interface IVibeRefactorAuditService {
	readonly _serviceBrand: undefined;

	/**
	 * Record a refactor operation as a single atomic audit entry.
	 * Rename symbol in N files = ONE audit entry + rollback in one action.
	 */
	recordRefactor(operation: RefactorOperation): string; // returns operation ID

	/** Get refactor operation by ID */
	getRefactor(operationId: string): RefactorOperation | undefined;
}

/**
 * VibeIDE Rename/Refactor Atomic Audit.
 * Rename symbol in N files = ONE audit log entry.
 * Rollback = one action, not N individual file reverts.
 */
class VibeRefactorAuditService extends Disposable implements IVibeRefactorAuditService {
	declare readonly _serviceBrand: undefined;

	private readonly _operations = new Map<string, RefactorOperation>();

	constructor(
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
		@IVibeAgentHistoryService private readonly _historyService: IVibeAgentHistoryService,
	) {
		super();
	}

	recordRefactor(operation: RefactorOperation): string {
		const operationId = `refactor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		this._operations.set(operationId, operation);

		// Record as SINGLE audit entry regardless of N files
		if (this._auditLogService.isEnabled()) {
			this._auditLogService.append({
				ts: Date.now(),
				action: 'apply',
				files: operation.affectedFiles,
				ok: true,
				meta: {
					operationId,
					type: `refactor:${operation.type}`,
					symbol: operation.symbol,
					from: operation.from,
					to: operation.to,
					totalChanges: operation.totalChanges,
					affectedFileCount: operation.affectedFiles.length,
				},
			});
		}

		// Single history entry (not N separate entries)
		this._historyService.recordAction({
			sessionId: `session-${Date.now()}`,
			action: `refactor:${operation.type}`,
			description: this._describeOperation(operation),
			files: operation.affectedFiles,
			canRollback: true,
		});

		vibeLog.info('RefactorAudit', `${operation.type}: ${operation.affectedFiles.length} files (id: ${operationId})`);
		return operationId;
	}

	getRefactor(operationId: string): RefactorOperation | undefined {
		return this._operations.get(operationId);
	}

	private _describeOperation(op: RefactorOperation): string {
		switch (op.type) {
			case 'rename': return `Renamed "${op.from}" → "${op.to}" in ${op.affectedFiles.length} files`;
			case 'move': return `Moved "${op.symbol}" from ${op.from} to ${op.to}`;
			case 'extract': return `Extracted function "${op.to}" from ${op.affectedFiles[0]}`;
			default: return `${op.type}: ${op.affectedFiles.length} files`;
		}
	}
}

registerSingleton(IVibeRefactorAuditService, VibeRefactorAuditService, InstantiationType.Eager);
