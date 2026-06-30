/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { serializePlanMarkdown } from '../../common/vibePersistedPlanService.js';
import type { PlanMessage } from '../../common/chatThreadServiceTypes.js';

const meta = { planId: 'abc12345-2abb-4588-8e60-5fd957bc1c58', threadId: 'thread-1', messageIdx: 7, createdAt: '2026-06-09T10:00:00.000Z', workspaceRootUri: 'file:///d:/proj' };

const plan = {
	role: 'plan',
	type: 'agent_plan',
	summary: 'Test plan',
	steps: [
		{ stepNumber: 1, description: 'done step', status: 'succeeded' },
		{ stepNumber: 2, description: 'failed step', status: 'failed' },
		{ stepNumber: 3, description: 'pending step', status: 'queued' },
		{ stepNumber: 4, description: 'skipped step', disabled: true },
	],
} as unknown as PlanMessage;

suite('serializePlanMarkdown — reflect step statuses + lifecycle status', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('completed plan: checkboxes + markers reflect each step status', () => {
		const md = serializePlanMarkdown(plan, meta, 'completed');
		assert.ok(md.includes('- [x] Step 1: done step'), 'succeeded → [x]');
		assert.ok(md.includes('- [ ] Step 2: failed step _(failed)_'), 'failed → [ ] + marker');
		assert.ok(md.includes('- [ ] Step 3: pending step'), 'queued → [ ]');
		assert.ok(md.includes('- ~~Step 4:~~ skipped step _(skipped)_'), 'disabled → strikethrough');
	});

	test('top-level status is written into frontmatter AND the JSON canonical', () => {
		const md = serializePlanMarkdown(plan, meta, 'completed');
		assert.ok(/^status: completed$/m.test(md), 'frontmatter status');
		const json = JSON.parse(md.match(/```json\s*([\s\S]*?)```/)![1]);
		assert.strictEqual(json.status, 'completed');
		assert.strictEqual(json.steps[0].status, 'succeeded');
		assert.strictEqual(json.steps[3].status, 'skipped');
		assert.strictEqual(json.steps[3].disabled, true);
	});

	test('preserves metadata (createdAt / boundThreadId / planMessageIdx / workspaceRootUri)', () => {
		const md = serializePlanMarkdown(plan, meta, 'running');
		assert.ok(md.includes('createdAt: "2026-06-09T10:00:00.000Z"'));
		assert.ok(md.includes('boundThreadId: "thread-1"'));
		assert.ok(md.includes('planMessageIdx: 7'));
		const json = JSON.parse(md.match(/```json\s*([\s\S]*?)```/)![1]);
		assert.strictEqual(json.workspaceRootUri, 'file:///d:/proj');
		assert.strictEqual(json.planMessageIdx, 7);
	});

	test('creation status running yields a clean unchecked snapshot for not-yet-run steps', () => {
		const fresh = { ...plan, steps: plan.steps.map(s => ({ ...s, status: 'queued', disabled: false })) } as PlanMessage;
		const md = serializePlanMarkdown(fresh, meta, 'running');
		assert.ok(/^status: running$/m.test(md));
		assert.ok(md.includes('- [ ] Step 1: done step'), 'all unchecked when queued');
		assert.ok(!md.includes('[x]'), 'no completed checkbox at creation');
	});
});
