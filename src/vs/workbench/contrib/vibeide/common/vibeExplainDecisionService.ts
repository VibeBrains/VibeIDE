/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IAuditLogService, AuditEvent } from './auditLogService.js';

export interface DecisionExplanation {
	checkpointId: string;
	action: string;
	reasoning: string;
	rulesApplied: string[];
	constraintsChecked: string[];
	modelId?: string;
}

export const IVibeExplainDecisionService = createDecorator<IVibeExplainDecisionService>('vibeExplainDecisionService');

export interface IVibeExplainDecisionService {
	readonly _serviceBrand: undefined;

	/** Reconstruct reasoning for a checkpoint from audit log */
	explainDecision(checkpointId: string): Promise<DecisionExplanation | null>;

	/** "What would change your decision?" — which rules would alter the outcome */
	whatWouldChange(checkpointId: string): Promise<string[]>;
}

/** Coerce an untyped audit-meta value into a string array, dropping non-string entries. */
function toStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * VibeIDE Explain This Decision.
 * Reconstructs agent reasoning from audit log for each checkpoint.
 * Powers: "Explain this decision" in Agent Action History sidebar.
 */
class VibeExplainDecisionService extends Disposable implements IVibeExplainDecisionService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
	) {
		super();
	}

	async explainDecision(checkpointId: string): Promise<DecisionExplanation | null> {
		const events = await this._auditLogService.queryRecent(100);
		const event = events.find(e =>
			e.meta?.historyId === checkpointId ||
			e.meta?.snapshotId === checkpointId
		);

		if (!event) {
			vibeLog.debug('ExplainDecision', `No event found for checkpoint: ${checkpointId}`);
			return null;
		}

		// Reconstruct reasoning from audit event metadata
		const reasoning = this._buildReasoning(event);

		return {
			checkpointId,
			action: event.action,
			reasoning,
			rulesApplied: toStringArray(event.meta?.rulesApplied),
			constraintsChecked: toStringArray(event.meta?.constraintsChecked),
			modelId: event.model,
		};
	}

	async whatWouldChange(checkpointId: string): Promise<string[]> {
		const explanation = await this.explainDecision(checkpointId);
		if (!explanation) { return []; }

		// Phase 1: generic suggestions based on action type
		// Phase 2: LLM-powered counterfactual analysis
		const suggestions: string[] = [];

		switch (explanation.action) {
			case 'apply':
				suggestions.push('Adding deny_write for affected files in .vibe/constraints.json would block this action');
				suggestions.push('Switching Trust Score to Manual 🟢 would require approval for each write');
				break;
			case 'rollback':
				suggestions.push('Named checkpoint before this change would provide cleaner rollback target');
				break;
			default:
				suggestions.push('Adding relevant rules to .vibe/rules.md could influence future similar decisions');
		}

		return suggestions;
	}

	private _buildReasoning(event: AuditEvent): string {
		const parts: string[] = [];

		if (event.model) { parts.push(`Used model: ${event.model}`); }
		if (event.files?.length) { parts.push(`Modified: ${event.files.slice(0, 3).join(', ')}${event.files.length > 3 ? '...' : ''}`); }
		if (event.latencyMs) { parts.push(`Latency: ${event.latencyMs}ms`); }
		if (event.ok !== undefined) { parts.push(`Outcome: ${event.ok ? 'success' : 'failed'}`); }

		if (parts.length === 0) {
			return 'Phase 2: LLM-powered reasoning reconstruction from full audit context.';
		}

		return parts.join(' | ') + '. Phase 2: full LLM reasoning explanation available.';
	}
}

registerSingleton(IVibeExplainDecisionService, VibeExplainDecisionService, InstantiationType.Delayed);
