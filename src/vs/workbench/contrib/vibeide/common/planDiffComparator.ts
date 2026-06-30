/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Persisted-plan diff comparator — pure helper.
 *
 * `vibePersistedPlanService` writes plan markdown + canonical JSON to
 * `.vibe/plans/<id>.plan.md`. When the user re-runs the plan or edits
 * the JSON manually, the runtime needs to know what changed so the UI
 * can show "+ added step / − removed step / ~ changed step".
 *
 * vscode-free: no imports beyond standard lib.
 */

export interface PlanStepLite {
	id: string;
	title: string;
	description?: string;
	status?: string;
}

export interface PlanLite {
	planId: string;
	title?: string;
	steps: ReadonlyArray<PlanStepLite>;
}

export type StepDiff =
	| { kind: 'added'; step: PlanStepLite }
	| { kind: 'removed'; step: PlanStepLite }
	| { kind: 'changed'; before: PlanStepLite; after: PlanStepLite; fields: ReadonlyArray<'title' | 'description' | 'status'> }
	| { kind: 'reordered'; step: PlanStepLite; oldIndex: number; newIndex: number };

export interface PlanDiff {
	planIdsMatch: boolean;
	titleChanged: boolean;
	stepDiffs: ReadonlyArray<StepDiff>;
	totalAdded: number;
	totalRemoved: number;
	totalChanged: number;
	totalReordered: number;
}

/**
 * Diff two plans by step id. Pure.
 *
 * Algorithm:
 *   - Build maps oldById / newById.
 *   - Walk new ids: id not in old → added; in both, fields differ →
 *     changed (with the list of differing fields); in both, same fields
 *     but different position → reordered.
 *   - Walk old ids: id not in new → removed.
 *
 * Stable order: emit added/changed/reordered following new step order;
 * removed steps appear last in their old order.
 */
export function diffPlans(before: PlanLite, after: PlanLite): PlanDiff {
	const planIdsMatch = before.planId === after.planId;
	const titleChanged = (before.title ?? '') !== (after.title ?? '');

	const oldById = new Map<string, { step: PlanStepLite; index: number }>();
	for (let i = 0; i < before.steps.length; i++) {
		oldById.set(before.steps[i].id, { step: before.steps[i], index: i });
	}
	const newById = new Map<string, { step: PlanStepLite; index: number }>();
	for (let i = 0; i < after.steps.length; i++) {
		newById.set(after.steps[i].id, { step: after.steps[i], index: i });
	}

	const stepDiffs: StepDiff[] = [];
	let totalAdded = 0;
	let totalRemoved = 0;
	let totalChanged = 0;
	let totalReordered = 0;

	for (let i = 0; i < after.steps.length; i++) {
		const newStep = after.steps[i];
		const old = oldById.get(newStep.id);
		if (!old) {
			stepDiffs.push({ kind: 'added', step: newStep });
			totalAdded++;
			continue;
		}
		const fields = compareStepFields(old.step, newStep);
		if (fields.length > 0) {
			stepDiffs.push({ kind: 'changed', before: old.step, after: newStep, fields });
			totalChanged++;
			continue;
		}
		if (old.index !== i) {
			stepDiffs.push({ kind: 'reordered', step: newStep, oldIndex: old.index, newIndex: i });
			totalReordered++;
		}
	}
	for (let i = 0; i < before.steps.length; i++) {
		const oldStep = before.steps[i];
		if (!newById.has(oldStep.id)) {
			stepDiffs.push({ kind: 'removed', step: oldStep });
			totalRemoved++;
		}
	}

	return {
		planIdsMatch, titleChanged, stepDiffs,
		totalAdded, totalRemoved, totalChanged, totalReordered,
	};
}

function compareStepFields(a: PlanStepLite, b: PlanStepLite): Array<'title' | 'description' | 'status'> {
	const fields: Array<'title' | 'description' | 'status'> = [];
	if (a.title !== b.title) { fields.push('title'); }
	if ((a.description ?? '') !== (b.description ?? '')) { fields.push('description'); }
	if ((a.status ?? '') !== (b.status ?? '')) { fields.push('status'); }
	return fields;
}

/**
 * Render a one-line summary of the diff for the UI banner. Pure.
 */
export function renderPlanDiffSummary(diff: PlanDiff): string {
	const parts: string[] = [];
	if (diff.totalAdded > 0) { parts.push(`+${diff.totalAdded}`); }
	if (diff.totalRemoved > 0) { parts.push(`−${diff.totalRemoved}`); }
	if (diff.totalChanged > 0) { parts.push(`~${diff.totalChanged}`); }
	if (diff.totalReordered > 0) { parts.push(`↕${diff.totalReordered}`); }
	if (diff.titleChanged) { parts.unshift('title changed'); }
	if (parts.length === 0) { return 'no changes'; }
	return parts.join(' / ');
}
