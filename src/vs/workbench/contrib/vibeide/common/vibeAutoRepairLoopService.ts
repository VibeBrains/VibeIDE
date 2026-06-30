/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export type RepairPhase = 'lint' | 'types' | 'tests' | 'fix';

export interface RepairIteration {
	repairChainId: string;
	phase: RepairPhase;
	iterationNum: number;
	passed: boolean;
	output?: string;
}

export const IVibeAutoRepairLoopService = createDecorator<IVibeAutoRepairLoopService>('vibeAutoRepairLoopService');

export interface IVibeAutoRepairLoopService {
	readonly _serviceBrand: undefined;

	/** Start an auto-repair loop (lint → types → tests → fix) */
	startRepairLoop(taskId: string): string; // returns repairChainId

	/** Record an iteration result */
	recordIteration(repairChainId: string, phase: RepairPhase, passed: boolean, output?: string): void;

	/** Check if a repairChainId is in the excluded set (for loop detector) */
	isRepairLoopStep(repairChainId: string): boolean;

	/** Get current repair loop status */
	getStatus(repairChainId: string): { totalIterations: number; lastPhase: RepairPhase | null; isComplete: boolean };

	readonly onIterationComplete: Event<RepairIteration>;
}

/**
 * VibeIDE Auto-repair Loop: lint → types → tests → fix.
 * KEY INVARIANTS:
 * 1. Repair loop steps EXCLUDED from loop detector
 * 2. In Auto mode: 🔴 confidence files recorded as agent:repair-override (NOT blocked)
 * 3. In Manual mode: each iteration requires user approval
 * 4. Separate 'repair context budget' prevents context overflow
 */
class VibeAutoRepairLoopService extends Disposable implements IVibeAutoRepairLoopService {
	declare readonly _serviceBrand: undefined;

	private readonly _onIterationComplete = this._register(new Emitter<RepairIteration>());
	readonly onIterationComplete = this._onIterationComplete.event;

	private readonly _activeChains = new Set<string>();
	private readonly _iterations = new Map<string, RepairIteration[]>();

	constructor(
	) {
		super();
	}

	startRepairLoop(taskId: string): string {
		const repairChainId = `repair-${taskId}-${Date.now()}`;
		this._activeChains.add(repairChainId);
		this._iterations.set(repairChainId, []);
		vibeLog.info('AutoRepair', `Started chain: ${repairChainId}`);
		return repairChainId;
	}

	recordIteration(repairChainId: string, phase: RepairPhase, passed: boolean, output?: string): void {
		const iterations = this._iterations.get(repairChainId) ?? [];
		const iteration: RepairIteration = {
			repairChainId,
			phase,
			iterationNum: iterations.length + 1,
			passed,
			output,
		};
		iterations.push(iteration);
		this._iterations.set(repairChainId, iterations);
		this._onIterationComplete.fire(iteration);

		if (passed) {
			vibeLog.info('AutoRepair', `✅ ${phase} passed (iteration ${iteration.iterationNum})`);
		} else {
			vibeLog.debug('AutoRepair', `❌ ${phase} failed (iteration ${iteration.iterationNum})`);
		}
	}

	isRepairLoopStep(repairChainId: string): boolean {
		return this._activeChains.has(repairChainId);
	}

	getStatus(repairChainId: string): { totalIterations: number; lastPhase: RepairPhase | null; isComplete: boolean } {
		const iterations = this._iterations.get(repairChainId) ?? [];
		const last = iterations[iterations.length - 1];
		const isComplete = last?.phase === 'tests' && last.passed;

		return {
			totalIterations: iterations.length,
			lastPhase: last?.phase ?? null,
			isComplete,
		};
	}
}

registerSingleton(IVibeAutoRepairLoopService, VibeAutoRepairLoopService, InstantiationType.Eager);
