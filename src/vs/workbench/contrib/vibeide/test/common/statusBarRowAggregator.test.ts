/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildUnifiedStatusBarSnapshot,
	findDuplicateStatusRowIds,
	StatusRowDescriptor,
} from '../../common/statusBarRowAggregator.js';

suite('Unified VibeIDE status-bar — aggregator', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('empty rows → primary hidden, no popup', () => {
		const r = buildUnifiedStatusBarSnapshot([]);
		assert.strictEqual(r.primary.hidden, true);
		assert.strictEqual(r.primary.text, '');
		assert.deepStrictEqual(r.popupRows, []);
	});

	test('single info row → primary visible, info severity', () => {
		const rows: StatusRowDescriptor[] = [{ id: 'ctx', label: 'Context window', severity: 'info' }];
		const r = buildUnifiedStatusBarSnapshot(rows);
		assert.strictEqual(r.primary.hidden, false);
		assert.strictEqual(r.primary.severity, 'info');
		assert.ok(r.primary.text.includes('VibeIDE'));
	});

	test('highest severity wins for primary badge', () => {
		const rows: StatusRowDescriptor[] = [
			{ id: 'a', label: 'A', severity: 'info' },
			{ id: 'b', label: 'B', severity: 'warn' },
			{ id: 'c', label: 'C', severity: 'success' },
		];
		const r = buildUnifiedStatusBarSnapshot(rows);
		assert.strictEqual(r.primary.severity, 'warn');
		assert.ok(r.primary.text.includes('warning'));
	});

	test('error severity beats warn', () => {
		const rows: StatusRowDescriptor[] = [
			{ id: 'a', label: 'A', severity: 'warn' },
			{ id: 'b', label: 'B', severity: 'error' },
		];
		const r = buildUnifiedStatusBarSnapshot(rows);
		assert.strictEqual(r.primary.severity, 'error');
	});

	test('top-severity row counter shown in primary text', () => {
		const rows: StatusRowDescriptor[] = [
			{ id: 'commands', label: 'Running', severity: 'warn', counter: 3 },
			{ id: 'ctx', label: 'Context', severity: 'info', counter: 99 },
		];
		const r = buildUnifiedStatusBarSnapshot(rows);
		assert.ok(r.primary.text.endsWith(' 3'));
	});

	test('counter zero / negative / non-finite → omitted from primary', () => {
		const rows: StatusRowDescriptor[] = [
			{ id: 'a', label: 'A', severity: 'warn', counter: 0 },
		];
		const r = buildUnifiedStatusBarSnapshot(rows);
		assert.ok(!/ \d+$/.test(r.primary.text));
	});

	test('disabled rows filtered out before composition', () => {
		const rows: StatusRowDescriptor[] = [
			{ id: 'a', label: 'A', severity: 'error', enabled: false },
			{ id: 'b', label: 'B', severity: 'info' },
		];
		const r = buildUnifiedStatusBarSnapshot(rows);
		assert.strictEqual(r.primary.severity, 'info');
		assert.deepStrictEqual(r.popupRows.map(p => p.id), ['b']);
	});

	test('popup sorted by priority ascending, then id', () => {
		const rows: StatusRowDescriptor[] = [
			{ id: 'z', label: 'Z', priority: 50 },
			{ id: 'a', label: 'A', priority: 100 },
			{ id: 'b', label: 'B', priority: 50 },
		];
		const r = buildUnifiedStatusBarSnapshot(rows);
		assert.deepStrictEqual(r.popupRows.map(p => p.id), ['b', 'z', 'a']);
	});

	test('default priority is 100', () => {
		const rows: StatusRowDescriptor[] = [
			{ id: 'a', label: 'A' },
			{ id: 'b', label: 'B', priority: 50 },
		];
		const r = buildUnifiedStatusBarSnapshot(rows);
		assert.strictEqual(r.popupRows[0].id, 'b');
	});

	test('tooltip lists all rows with bullets', () => {
		const rows: StatusRowDescriptor[] = [
			{ id: 'a', label: 'A', priority: 1 },
			{ id: 'b', label: 'B', priority: 2, counter: 5 },
		];
		const r = buildUnifiedStatusBarSnapshot(rows);
		assert.ok(r.primary.tooltip.includes('• A'));
		assert.ok(r.primary.tooltip.includes('• B: 5'));
	});

	test('tooltip includes per-row tooltip suffix when present', () => {
		const rows: StatusRowDescriptor[] = [
			{ id: 'a', label: 'A', tooltip: 'click for details' },
		];
		const r = buildUnifiedStatusBarSnapshot(rows);
		assert.ok(r.primary.tooltip.includes('— click for details'));
	});

	test('all-disabled → hidden primary', () => {
		const rows: StatusRowDescriptor[] = [
			{ id: 'a', label: 'A', enabled: false },
			{ id: 'b', label: 'B', enabled: false },
		];
		const r = buildUnifiedStatusBarSnapshot(rows);
		assert.strictEqual(r.primary.hidden, true);
	});

	suite('findDuplicateStatusRowIds', () => {
		test('clean → empty', () => {
			assert.deepStrictEqual(
				findDuplicateStatusRowIds([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]),
				[],
			);
		});

		test('reports each duplicate id once, sorted', () => {
			const r = findDuplicateStatusRowIds([
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
				{ id: 'a', label: 'A2' },
				{ id: 'a', label: 'A3' },
				{ id: 'c', label: 'C' },
				{ id: 'b', label: 'B2' },
			]);
			assert.deepStrictEqual(r, ['a', 'b']);
		});
	});
});
