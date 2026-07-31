/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decideDesignHook, floorFindings, touchesUi } from '../../common/designReview/designHookPolicy.js';
import { Finding } from '../../common/designReview/designSnapshot.js';

const finding = (over: Partial<Finding> = {}): Finding => ({
	rule: 'low-contrast',
	severity: 'error',
	ruleClass: 'floor',
	message: 'Контраст 3.10:1 при норме 4.5:1',
	why: 'Ниже порога WCAG AA текст пропадает.',
	selector: '.faded',
	evidence: 'цвет 190,190,190 на фоне 255,255,255',
	...over,
});

const drift = (over: Partial<Finding> = {}): Finding =>
	finding({ rule: 'kicker-label', severity: 'info', ruleClass: 'drift', ...over });

suite('designHookPolicy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only interface files arm the hook — tests and services do not', () => {
		assert.deepStrictEqual(
			[
				touchesUi(['/repo/src/app.css']),
				touchesUi(['/repo/src/Panel.tsx']),
				touchesUi(['/repo/src/index.html', '/repo/README.md']),
				touchesUi(['/repo/src/Panel.test.tsx']),
				touchesUi(['/repo/src/vibeService.ts']),
				touchesUi([]),
			],
			[true, true, true, false, false, false],
		);
	});

	test('an unmeasured page stays silent instead of reporting a clean sheet', () => {
		assert.strictEqual(
			decideDesignHook({ mode: 'enforceFloor', measured: false, findings: [], attemptsUsed: 0, maxAttempts: 2 }),
			'quiet',
		);
	});

	test('notify reports and lets the turn end; enforceFloor sends the model back on floor findings', () => {
		const both = [finding(), drift()];
		assert.deepStrictEqual(
			[
				decideDesignHook({ mode: 'off', measured: true, findings: both, attemptsUsed: 0, maxAttempts: 2 }),
				decideDesignHook({ mode: 'notify', measured: true, findings: both, attemptsUsed: 0, maxAttempts: 2 }),
				decideDesignHook({ mode: 'enforceFloor', measured: true, findings: both, attemptsUsed: 0, maxAttempts: 2 }),
				// style only: taste never blocks a run
				decideDesignHook({ mode: 'enforceFloor', measured: true, findings: [drift()], attemptsUsed: 0, maxAttempts: 2 }),
				// attempts exhausted: report instead of looping forever
				decideDesignHook({ mode: 'enforceFloor', measured: true, findings: both, attemptsUsed: 2, maxAttempts: 2 }),
				decideDesignHook({ mode: 'notify', measured: true, findings: [], attemptsUsed: 0, maxAttempts: 2 }),
			],
			['quiet', 'note', 'bounce', 'note', 'note', 'quiet'],
		);
	});

	test('a finding the project accepted is neither reported nor blocked on', () => {
		const accepted = [drift({ accepted: { reason: 'моногарнитура — идентичность' } })];
		assert.deepStrictEqual(
			[
				decideDesignHook({ mode: 'notify', measured: true, findings: accepted, attemptsUsed: 0, maxAttempts: 2 }),
				floorFindings([finding(), drift(), finding({ accepted: { reason: 'заявлено' } })]).map(f => f.rule),
			],
			['quiet', ['low-contrast']],
		);
	});
});
