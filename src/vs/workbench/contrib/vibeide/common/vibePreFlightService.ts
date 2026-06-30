/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export interface PreFlightStep {
	type: 'file_write' | 'file_read' | 'shell_command' | 'mcp_call' | 'llm_call';
	description: string;
	filePaths?: string[];
	command?: string;
}

export interface PreFlightPlan {
	planId: string;
	taskDescription: string;
	steps: PreFlightStep[];
	estimatedFiles: number;
	estimatedCommands: number;
	costEstimate?: {
		worstCaseUsd: number;
		withCacheUsd: number;
	};
	createdAt: number;
}

export type PreFlightDecision = 'approved' | 'edited' | 'cancelled';

export interface PreFlightResult {
	plan: PreFlightPlan;
	decision: PreFlightDecision;
	editedPlan?: PreFlightPlan;
	decidedAt: number;
}

export const IVibePreFlightService = createDecorator<IVibePreFlightService>('vibePreFlightService');

export interface IVibePreFlightService {
	readonly _serviceBrand: undefined;

	/** Present pre-flight plan to user for approval */
	requestApproval(plan: Omit<PreFlightPlan, 'planId' | 'createdAt'>): Promise<PreFlightResult>;

	/** User approves the plan */
	approve(planId: string): void;

	/** User cancels */
	cancel(planId: string): void;

	/** Get current plan drift ratio (actual vs planned steps) */
	checkDrift(planId: string, actualSteps: number): boolean;

	readonly onPlanPresented: Event<PreFlightPlan>;
	readonly onPlanDecided: Event<PreFlightResult>;
}

/**
 * VibeIDE Agent Pre-flight Plan.
 * Before execution: shows plan (N files, M commands, ~$X) → Approve / Edit / Cancel.
 * DMS timer starts AFTER first Approve (not during pre-flight waiting).
 *
 * Plan drift: if actual scope exceeds 2× planned → pause and show updated plan.
 */
class VibePreFlightService extends Disposable implements IVibePreFlightService {
	declare readonly _serviceBrand: undefined;

	private readonly _onPlanPresented = this._register(new Emitter<PreFlightPlan>());
	readonly onPlanPresented = this._onPlanPresented.event;

	private readonly _onPlanDecided = this._register(new Emitter<PreFlightResult>());
	readonly onPlanDecided = this._onPlanDecided.event;

	private readonly _pending = new Map<string, {
		plan: PreFlightPlan;
		resolve: (result: PreFlightResult) => void;
	}>();

	private static readonly DRIFT_THRESHOLD = 2; // 2× planned steps = drift

	constructor(
	) {
		super();
	}

	async requestApproval(plan: Omit<PreFlightPlan, 'planId' | 'createdAt'>): Promise<PreFlightResult> {
		const fullPlan: PreFlightPlan = {
			...plan,
			planId: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			createdAt: Date.now(),
		};

		vibeLog.debug('PreFlight', `Plan: ${plan.estimatedFiles} files, ${plan.estimatedCommands} commands`);
		this._onPlanPresented.fire(fullPlan);

		return new Promise<PreFlightResult>(resolve => {
			this._pending.set(fullPlan.planId, { plan: fullPlan, resolve });
		});
	}

	approve(planId: string): void {
		const pending = this._pending.get(planId);
		if (!pending) { return; }
		this._pending.delete(planId);
		const result: PreFlightResult = {
			plan: pending.plan,
			decision: 'approved',
			decidedAt: Date.now(),
		};
		pending.resolve(result);
		this._onPlanDecided.fire(result);
	}

	cancel(planId: string): void {
		const pending = this._pending.get(planId);
		if (!pending) { return; }
		this._pending.delete(planId);
		const result: PreFlightResult = {
			plan: pending.plan,
			decision: 'cancelled',
			decidedAt: Date.now(),
		};
		pending.resolve(result);
		this._onPlanDecided.fire(result);
	}

	checkDrift(planId: string, actualSteps: number): boolean {
		// Get original planned steps count — for now use actualSteps threshold
		// In Phase 2: compare with stored plan.steps.length
		const ARBITRARY_PLAN_THRESHOLD = 5; // fallback if plan not found
		const pending = this._pending.get(planId);
		const plannedSteps = pending?.plan.steps.length ?? ARBITRARY_PLAN_THRESHOLD;
		const isDrift = actualSteps > plannedSteps * VibePreFlightService.DRIFT_THRESHOLD;
		if (isDrift) {
			vibeLog.warn('PreFlight', `Plan drift detected: ${actualSteps} actual steps vs ${plannedSteps} planned`);
		}
		return isDrift;
	}
}

registerSingleton(IVibePreFlightService, VibePreFlightService, InstantiationType.Eager);
