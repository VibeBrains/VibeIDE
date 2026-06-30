/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export type ToolApprovalDecision = 'approved' | 'rejected' | 'pending';

export interface ToolApprovalRequest {
	requestId: string;
	toolName: string;
	params: Record<string, unknown>;
	rationale: string; // Why this tool call is needed right now
	timestamp: number;
	trustScoreLevel: 'manual' | 'supervised' | 'auto';
}

export interface ToolApprovalEvent {
	request: ToolApprovalRequest;
	decision: ToolApprovalDecision;
	decidedAt?: number;
}

export const IVibeToolApprovalService = createDecorator<IVibeToolApprovalService>('vibeToolApprovalService');

export interface IVibeToolApprovalService {
	readonly _serviceBrand: undefined;

	/** Request approval for a tool use (in Manual trust mode) */
	requestApproval(request: Omit<ToolApprovalRequest, 'timestamp'>): Promise<ToolApprovalDecision>;

	/** Grant approval (called by UI on Approve click/keyboard) */
	approve(requestId: string): void;

	/** Reject a tool use */
	reject(requestId: string): void;

	/** Get pending approval requests */
	getPendingRequests(): ToolApprovalRequest[];

	readonly onApprovalRequested: Event<ToolApprovalRequest>;
	readonly onApprovalDecided: Event<ToolApprovalEvent>;
}

/**
 * VibeIDE Tool Approval Service: Explicit tool approval mode.
 * In Manual trust mode: every tool-use (write_file, run_command, HTTP)
 * requires one click or keyboard shortcut from user.
 *
 * Per-tool-call rationale: each request includes a one-sentence explanation
 * of WHY this tool call is needed right now in the context of the task.
 */
class VibeToolApprovalService extends Disposable implements IVibeToolApprovalService {
	declare readonly _serviceBrand: undefined;

	private readonly _onApprovalRequested = this._register(new Emitter<ToolApprovalRequest>());
	readonly onApprovalRequested = this._onApprovalRequested.event;

	private readonly _onApprovalDecided = this._register(new Emitter<ToolApprovalEvent>());
	readonly onApprovalDecided = this._onApprovalDecided.event;

	private readonly _pending = new Map<string, {
		request: ToolApprovalRequest;
		resolve: (decision: ToolApprovalDecision) => void;
	}>();

	constructor(
	) {
		super();
	}

	async requestApproval(request: Omit<ToolApprovalRequest, 'timestamp'>): Promise<ToolApprovalDecision> {
		const fullRequest: ToolApprovalRequest = { ...request, timestamp: Date.now() };

		// In Auto mode: auto-approve
		if (request.trustScoreLevel === 'auto') {
			return 'approved';
		}

		vibeLog.debug('ToolApproval', `Requesting approval: ${request.toolName} — ${request.rationale}`);
		this._onApprovalRequested.fire(fullRequest);

		return new Promise<ToolApprovalDecision>(resolve => {
			this._pending.set(request.requestId, { request: fullRequest, resolve });

			// Supervised mode: auto-approve after timeout (from DMS settings)
			if (request.trustScoreLevel === 'supervised') {
				setTimeout(() => {
					if (this._pending.has(request.requestId)) {
						this.approve(request.requestId);
					}
				}, 30_000); // 30s auto-approve in supervised mode
			}
		});
	}

	approve(requestId: string): void {
		const pending = this._pending.get(requestId);
		if (!pending) { return; }
		this._pending.delete(requestId);
		vibeLog.debug('ToolApproval', `Approved: ${pending.request.toolName}`);
		pending.resolve('approved');
		this._onApprovalDecided.fire({ request: pending.request, decision: 'approved', decidedAt: Date.now() });
	}

	reject(requestId: string): void {
		const pending = this._pending.get(requestId);
		if (!pending) { return; }
		this._pending.delete(requestId);
		vibeLog.debug('ToolApproval', `Rejected: ${pending.request.toolName}`);
		pending.resolve('rejected');
		this._onApprovalDecided.fire({ request: pending.request, decision: 'rejected', decidedAt: Date.now() });
	}

	getPendingRequests(): ToolApprovalRequest[] {
		return Array.from(this._pending.values()).map(p => p.request);
	}
}

registerSingleton(IVibeToolApprovalService, VibeToolApprovalService, InstantiationType.Eager);
