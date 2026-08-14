/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AcpToolCallTracker } from '../../common/acp/acpToolCallTracker.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('acpToolCallTracker', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const diff = { path: '/app/hello.txt', oldText: 'привет мир', newText: 'привет друг' };

	test('дифф из среднего кадра доживает до завершающего — порядок живого прогона', () => {
		// Так Claude Code и рассказывает о правке: сперва вызов без подробностей, затем дифф,
		// затем завершение с одним лишь текстовым итогом. Ждать диффа от последнего кадра —
		// значит не записать ни одной правки.
		const tracker = new AcpToolCallTracker();
		const pending = tracker.accept('t1', 'Edit', 'pending', []);
		const shown = tracker.accept('t1', 'Edit /app/hello.txt', 'unknown', [diff]);
		const done = tracker.accept('t1', '', 'completed', []);
		assert.deepStrictEqual([pending, shown, done], [
			undefined,
			undefined,
			{ toolCallId: 't1', title: 'Edit /app/hello.txt', diffs: [diff], failed: false },
		]);
	});

	test('два вызова одновременно не перемешиваются', () => {
		const other = { path: '/app/b.ts', oldText: 'а', newText: 'б' };
		const tracker = new AcpToolCallTracker();
		tracker.accept('t1', 'Edit A', 'pending', [diff]);
		tracker.accept('t2', 'Edit B', 'pending', [other]);
		assert.deepStrictEqual(
			[tracker.accept('t2', '', 'completed', [])?.diffs, tracker.accept('t1', '', 'completed', [])?.diffs],
			[[other], [diff]]);
	});

	test('провалившийся вызов отдаётся с признаком, а не молчит', () => {
		const tracker = new AcpToolCallTracker();
		tracker.accept('t1', 'Edit', 'in_progress', [diff]);
		assert.deepStrictEqual(tracker.accept('t1', '', 'failed', []), { toolCallId: 't1', title: 'Edit', diffs: [diff], failed: true });
	});

	test('вызов без правки закрывается пустым — записывать нечего', () => {
		const tracker = new AcpToolCallTracker();
		tracker.accept('t1', 'Read', 'pending', []);
		assert.deepStrictEqual(tracker.accept('t1', 'Read', 'completed', []), { toolCallId: 't1', title: 'Read', diffs: [], failed: false });
	});

	test('конец хода не оставляет недосказанных вызовов', () => {
		const tracker = new AcpToolCallTracker();
		tracker.accept('t1', 'Edit', 'pending', [diff]);
		tracker.reset();
		assert.deepStrictEqual([tracker.openCount, tracker.accept('t1', '', 'completed', [])?.diffs], [0, []]);
	});
});
