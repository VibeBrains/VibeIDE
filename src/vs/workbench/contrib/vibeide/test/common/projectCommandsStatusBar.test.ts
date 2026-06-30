/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildProjectCommandsStatusBarState } from '../../common/projectCommandsStatusBar.js';

suite('Project Commands — status-bar ▶ N formatter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('zero count → hidden, empty text', () => {
		const r = buildProjectCommandsStatusBarState({ runningCount: 0 });
		assert.deepStrictEqual(r, { text: '', visible: false, tooltip: '' });
	});

	test('one running → ▶ 1, RU singular tooltip', () => {
		const r = buildProjectCommandsStatusBarState({ runningCount: 1 });
		assert.strictEqual(r.text, '▶ 1');
		assert.ok(r.visible);
		assert.ok(r.tooltip.includes('1 команда'));
	});

	test('two running → ▶ 2, RU genitive plural', () => {
		const r = buildProjectCommandsStatusBarState({ runningCount: 2 });
		assert.strictEqual(r.text, '▶ 2');
		assert.ok(r.tooltip.includes('2 команды'));
	});

	test('five running → ▶ 5, RU genitive plural form', () => {
		const r = buildProjectCommandsStatusBarState({ runningCount: 5 });
		assert.strictEqual(r.text, '▶ 5');
		assert.ok(r.tooltip.includes('5 команд'));
	});

	test('eleven (special slavic 11-14 → команд)', () => {
		const r = buildProjectCommandsStatusBarState({ runningCount: 11 });
		assert.strictEqual(r.text, '▶ 11');
		assert.ok(r.tooltip.includes('11 команд'));
	});

	test('twenty-one (последняя 1 → команда)', () => {
		const r = buildProjectCommandsStatusBarState({ runningCount: 21 });
		assert.strictEqual(r.text, '▶ 21');
		assert.ok(r.tooltip.includes('21'));
		assert.ok(r.tooltip.includes('команд'));
	});

	test('lists names up to 5 with bullets', () => {
		const r = buildProjectCommandsStatusBarState({
			runningCount: 3,
			runningNames: ['Build', 'Test', 'Lint'],
		});
		assert.ok(r.tooltip.includes('• Build'));
		assert.ok(r.tooltip.includes('• Test'));
		assert.ok(r.tooltip.includes('• Lint'));
		assert.ok(!r.tooltip.includes('…ещё'));
	});

	test('overflow ellipsis when more than 5 names', () => {
		const r = buildProjectCommandsStatusBarState({
			runningCount: 7,
			runningNames: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
		});
		assert.ok(r.tooltip.includes('• a'));
		assert.ok(r.tooltip.includes('• e'));
		assert.ok(!r.tooltip.includes('• f'));
		assert.ok(r.tooltip.includes('…ещё 2'));
	});

	test('non-finite / negative / non-number → hidden', () => {
		assert.strictEqual(buildProjectCommandsStatusBarState({ runningCount: -1 }).visible, false);
		assert.strictEqual(buildProjectCommandsStatusBarState({ runningCount: NaN }).visible, false);
		assert.strictEqual(buildProjectCommandsStatusBarState({ runningCount: Infinity }).visible, false);
		assert.strictEqual(buildProjectCommandsStatusBarState({ runningCount: 'three' as unknown as number }).visible, false);
	});

	test('floors fractional count', () => {
		const r = buildProjectCommandsStatusBarState({ runningCount: 3.7 });
		assert.strictEqual(r.text, '▶ 3');
	});

	test('drops empty / whitespace-only names from list', () => {
		const r = buildProjectCommandsStatusBarState({
			runningCount: 4,
			runningNames: ['Build', '   ', '', 'Lint'],
		});
		assert.ok(r.tooltip.includes('• Build'));
		assert.ok(r.tooltip.includes('• Lint'));
		assert.ok(!r.tooltip.includes('•  '));
	});

	test('non-string entries silently skipped', () => {
		const r = buildProjectCommandsStatusBarState({
			runningCount: 2,
			runningNames: ['Build', 42 as unknown as string],
		});
		assert.ok(r.tooltip.includes('• Build'));
		assert.ok(!r.tooltip.includes('42'));
	});
});
