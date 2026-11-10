/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decideRestore, RESTORE_CRASH_WINDOW_MS } from '../../common/chatRestoreCrashGuard.js';

suite('chatRestoreCrashGuard — защита от петли падений', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const NOW = 1_700_000_000_000;

	test('первый запуск: падений нет, вкладки восстанавливаем', () => {
		const { restoreTabs, next } = decideRestore(undefined, NOW);
		assert.strictEqual(next.crashes, 0);
		assert.strictEqual(restoreTabs, true);
		assert.strictEqual(next.pendingSince, NOW);
	});

	test('одно падение подряд: вкладки ещё восстанавливаем', () => {
		const first = decideRestore(undefined, NOW);
		const second = decideRestore(first.next, NOW + 30_000);
		assert.strictEqual(second.next.crashes, 1);
		assert.strictEqual(second.restoreTabs, true);
	});

	test('два падения подряд: вкладки не восстанавливаем', () => {
		const first = decideRestore(undefined, NOW);
		const second = decideRestore(first.next, NOW + 30_000);
		const third = decideRestore(second.next, NOW + 60_000);
		assert.strictEqual(third.next.crashes, 2);
		assert.strictEqual(third.restoreTabs, false);
	});

	test('третье падение подряд тоже не восстанавливает вкладки', () => {
		const first = decideRestore(undefined, NOW);
		const second = decideRestore(first.next, NOW + 30_000);
		const third = decideRestore(second.next, NOW + 60_000);
		const fourth = decideRestore(third.next, NOW + 90_000);
		assert.strictEqual(fourth.next.crashes, 3);
		assert.strictEqual(fourth.restoreTabs, false);
	});

	test('старая отметка (> 10 минут) сбрасывает счётчик', () => {
		const { restoreTabs, next } = decideRestore({ pendingSince: NOW - RESTORE_CRASH_WINDOW_MS - 1, crashes: 5 }, NOW);
		assert.strictEqual(next.crashes, 0);
		assert.strictEqual(restoreTabs, true);
	});
});
