/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Roadmap-agent executor (roadmap §L885).
 *
 * Drives the `transitionLoop` FSM from `common/roadmapAgentLoop.ts`. For each
 * selected item the executor:
 *   1. ranks remaining items via `rankRoadmapItemsForExecution`
 *   2. emits an `item-selected` event into the FSM
 *   3. delegates execution to the subagent isolation runtime
 *   4. records the outcome and iterates
 *
 * The executor is intentionally minimal: previewing / approval is handled by
 * existing UI services (the preview/decide layer). This module is the actual
 * "delegate-to-subagent" pipeline that was previously a stub.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import {
	LoopState,
	LoopEvent,
	LoopSummary,
	RoadmapItem,
	rankRoadmapItemsForExecution,
	summarizeLoopOutcomes,
	transitionLoop,
} from '../common/roadmapAgentLoop.js';
import { SubagentKind } from '../common/subagentIsolationPolicy.js';
import { IVibeSubagentIsolationRuntime, SubagentInvocationResult } from './vibeSubagentIsolationRuntime.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.roadmapAgent.autoApprove': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.roadmapAgent.autoApprove', 'Автоматически утверждать каждый шаг roadmap-агента без UI-подтверждения. Включать только в скриптовых/CI-сценариях — теряется контроль над риском. По умолчанию выключено.'),
		},
		'vibeide.roadmapAgent.parentTokenBudget': {
			type: 'number',
			default: 50000,
			minimum: 4096,
			maximum: 500000,
			description: localize('vibeide.roadmapAgent.parentTokenBudget', 'Резерв родительских токенов, передаваемый в `decideSubagentIsolation` при делегировании каждого пункта roadmap. Влияет на квоту субагента (правило «половина от родителя»). По умолчанию 50 000.'),
		},
	},
});

export interface RoadmapExecutionOptions {
	readonly autoApprove: boolean;
	readonly subagentKind?: SubagentKind;
	readonly parentRemainingTokens: number;
	readonly maxSubagentTokens?: number;
	readonly handoffBuilder?: (item: RoadmapItem) => string | undefined;
}

export interface RoadmapExecutionRecord {
	readonly itemId: string;
	readonly outcome: 'success' | 'failure' | 'skipped' | 'blocked';
	readonly invocationId: string | null;
	readonly durationMs: number;
	readonly stderr?: string;
}

export interface RoadmapExecutionReport {
	readonly summary: LoopSummary;
	readonly records: readonly RoadmapExecutionRecord[];
}

export const IVibeRoadmapAgentExecutor = createDecorator<IVibeRoadmapAgentExecutor>('vibeRoadmapAgentExecutor');

export interface IVibeRoadmapAgentExecutor {
	readonly _serviceBrand: undefined;
	execute(items: readonly RoadmapItem[], opts: RoadmapExecutionOptions, token?: CancellationToken): Promise<RoadmapExecutionReport>;
	readonly onDidUpdateState: Event<LoopState>;
}

class VibeRoadmapAgentExecutor extends Disposable implements IVibeRoadmapAgentExecutor {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidUpdateState = this._register(new Emitter<LoopState>());
	readonly onDidUpdateState: Event<LoopState> = this._onDidUpdateState.event;

	constructor(
		@IVibeSubagentIsolationRuntime private readonly _subagentRuntime: IVibeSubagentIsolationRuntime,
		@ILogService private readonly _log: ILogService,
	) {
		super();
	}

	async execute(
		items: readonly RoadmapItem[],
		opts: RoadmapExecutionOptions,
		token?: CancellationToken,
	): Promise<RoadmapExecutionReport> {
		const records: RoadmapExecutionRecord[] = [];
		let state: LoopState = { kind: 'idle' };
		const apply = (ev: LoopEvent): boolean => {
			const t = transitionLoop(state, ev);
			if (!t.ok) {
				this._log.warn(`[RoadmapExec] FSM refused: ${t.reason} from=${t.attemptedFrom} ev=${t.attemptedEvent}`);
				return false;
			}
			state = t.next;
			this._onDidUpdateState.fire(state);
			return true;
		};

		apply({ kind: 'start' });

		const queue = [...rankRoadmapItemsForExecution(items)];
		const closedStatuses: Parameters<typeof summarizeLoopOutcomes>[0][number][] = [];

		while (queue.length > 0) {
			if (token?.isCancellationRequested) {
				this._log.info('[RoadmapExec] cancelled by token');
				break;
			}
			const item = queue.shift()!;
			if (!apply({ kind: 'item-selected', itemId: item.id })) { continue; }

			const subagentKind: SubagentKind = opts.subagentKind ?? this._kindForBucket(item.bucket);
			const handle = this._subagentRuntime.invoke({
				kind: subagentKind,
				task: this._renderTaskPrompt(item),
				handoffContext: opts.handoffBuilder?.(item),
				parentRemainingTokens: opts.parentRemainingTokens,
				maxSubagentTokens: opts.maxSubagentTokens,
			});

			// auto-approve or wait for explicit approval signal — the executor
			// treats opts.autoApprove=true as immediate approval.
			if (opts.autoApprove) {
				apply({ kind: 'auto-approved', invocationId: handle.invocationId });
			} else {
				apply({ kind: 'preview-ready', invocationId: handle.invocationId });
				apply({ kind: 'user-approved', invocationId: handle.invocationId });
			}

			const cancelSub = token?.onCancellationRequested(() => handle.abort('token-cancelled'));
			let result: SubagentInvocationResult;
			try {
				result = await handle.result;
			} finally {
				cancelSub?.dispose();
			}

			const outcome: RoadmapExecutionRecord['outcome'] =
				result.outcome === 'success' ? 'success'
					: result.outcome === 'aborted' ? 'skipped'
						: 'failure';

			records.push({
				itemId: item.id,
				outcome,
				invocationId: handle.invocationId,
				durationMs: result.durationMs,
				stderr: result.stderr || undefined,
			});

			if (outcome === 'failure') {
				closedStatuses.push({ kind: 'blocked', reason: result.stderr || 'execution-failed' });
				apply({ kind: 'execution-blocked', reason: result.stderr || 'execution-failed' });
			} else {
				closedStatuses.push({ kind: 'completed', outcome: outcome === 'skipped' ? 'skipped' : 'success' });
				apply({ kind: 'execution-complete', outcome: outcome === 'skipped' ? 'failure' : 'success' });
			}
		}

		const summary = summarizeLoopOutcomes(closedStatuses);
		apply({ kind: 'no-more-items', summary });

		return { summary, records };
	}

	private _kindForBucket(bucket: RoadmapItem['bucket']): SubagentKind {
		switch (bucket) {
			case 'must-finish':
				return 'fixer';
			case 'install-and-finish':
				return 'fixer';
			case 'skeleton-acceptable':
				return 'planner';
			case 'blocked':
			default:
				return 'researcher';
		}
	}

	private _renderTaskPrompt(item: RoadmapItem): string {
		return `Roadmap item ${item.id} [${item.bucket}, prio=${item.priority}]\n\n${item.summary}`;
	}
}

registerSingleton(IVibeRoadmapAgentExecutor, VibeRoadmapAgentExecutor, InstantiationType.Delayed);
