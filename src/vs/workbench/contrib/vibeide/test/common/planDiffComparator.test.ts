/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	diffPlans,
	renderPlanDiffSummary,
	PlanLite,
	PlanStepLite,
} from '../../common/planDiffComparator.js';

const step = (id: string, title: string, extra: Partial<PlanStepLite> = {}): PlanStepLite => ({
	id, title, ...extra,
});

const plan = (id: string, steps: PlanStepLite[], title?: string): PlanLite => ({
	planId: id,
	title,
	steps,
});

suite('Plan diff comparator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('diffPlans', () => {
		test('identical plans → no changes', () => {
			const p = plan('p1', [step('s1', 'A'), step('s2', 'B')], 'Plan');
			const d = diffPlans(p, p);
			assert.strictEqual(d.totalAdded, 0);
			assert.strictEqual(d.totalRemoved, 0);
			assert.strictEqual(d.totalChanged, 0);
			assert.strictEqual(d.totalReordered, 0);
			assert.strictEqual(d.titleChanged, false);
		});

		test('added step', () => {
			const before = plan('p1', [step('s1', 'A')]);
			const after = plan('p1', [step('s1', 'A'), step('s2', 'B')]);
			const d = diffPlans(before, after);
			assert.strictEqual(d.totalAdded, 1);
			assert.strictEqual(d.stepDiffs[0].kind, 'added');
			if (d.stepDiffs[0].kind === 'added') {
				assert.strictEqual(d.stepDiffs[0].step.id, 's2');
			}
		});

		test('removed step', () => {
			const before = plan('p1', [step('s1', 'A'), step('s2', 'B')]);
			const after = plan('p1', [step('s1', 'A')]);
			const d = diffPlans(before, after);
			assert.strictEqual(d.totalRemoved, 1);
			const removed = d.stepDiffs.find(x => x.kind === 'removed');
			assert.ok(removed);
		});

		test('changed step (title only)', () => {
			const before = plan('p1', [step('s1', 'A')]);
			const after = plan('p1', [step('s1', 'A renamed')]);
			const d = diffPlans(before, after);
			assert.strictEqual(d.totalChanged, 1);
			const changed = d.stepDiffs.find(x => x.kind === 'changed');
			if (changed?.kind === 'changed') {
				assert.deepStrictEqual(changed.fields, ['title']);
			}
		});

		test('changed step (multiple fields)', () => {
			const before = plan('p1', [step('s1', 'A', { description: 'd1', status: 'pending' })]);
			const after = plan('p1', [step('s1', 'B', { description: 'd2', status: 'done' })]);
			const d = diffPlans(before, after);
			const changed = d.stepDiffs.find(x => x.kind === 'changed');
			if (changed?.kind === 'changed') {
				assert.deepStrictEqual(changed.fields, ['title', 'description', 'status']);
			}
		});

		test('reordered step (no field change, different position)', () => {
			const s1 = step('s1', 'A');
			const s2 = step('s2', 'B');
			const before = plan('p1', [s1, s2]);
			const after = plan('p1', [s2, s1]);
			const d = diffPlans(before, after);
			assert.strictEqual(d.totalReordered, 2);
			assert.strictEqual(d.totalChanged, 0);
		});

		test('changed step does not also count as reordered', () => {
			const before = plan('p1', [step('s1', 'A'), step('s2', 'B')]);
			const after = plan('p1', [step('s2', 'B'), step('s1', 'A modified')]);
			const d = diffPlans(before, after);
			assert.strictEqual(d.totalChanged, 1);
			assert.strictEqual(d.totalReordered, 1); // only s2 moved without changes
		});

		test('different planId flagged', () => {
			const before = plan('p1', [step('s1', 'A')]);
			const after = plan('p2', [step('s1', 'A')]);
			const d = diffPlans(before, after);
			assert.strictEqual(d.planIdsMatch, false);
		});

		test('title change flagged', () => {
			const before = plan('p1', [], 'Old');
			const after = plan('p1', [], 'New');
			const d = diffPlans(before, after);
			assert.strictEqual(d.titleChanged, true);
		});

		test('mixed add/remove/change', () => {
			const before = plan('p1', [
				step('s1', 'A'),
				step('s2', 'B'),
				step('s3', 'C'),
			]);
			const after = plan('p1', [
				step('s1', 'A renamed'),
				step('s4', 'D'),
			]);
			const d = diffPlans(before, after);
			assert.strictEqual(d.totalChanged, 1);
			assert.strictEqual(d.totalAdded, 1);
			assert.strictEqual(d.totalRemoved, 2);
		});
	});

	suite('renderPlanDiffSummary', () => {
		test('no changes', () => {
			const d = diffPlans(plan('p1', [step('s1', 'A')]), plan('p1', [step('s1', 'A')]));
			assert.strictEqual(renderPlanDiffSummary(d), 'no changes');
		});

		test('mixed counts join with /', () => {
			const d = diffPlans(
				plan('p1', [step('s1', 'A'), step('s2', 'B')]),
				plan('p1', [step('s1', 'A renamed'), step('s3', 'C')]),
			);
			const s = renderPlanDiffSummary(d);
			assert.match(s, /\+1/);
			assert.match(s, /−1/);
			assert.match(s, /~1/);
		});

		test('title change is prefixed', () => {
			const d = diffPlans(plan('p1', [], 'A'), plan('p1', [], 'B'));
			const s = renderPlanDiffSummary(d);
			assert.match(s, /^title changed/);
		});
	});
});
