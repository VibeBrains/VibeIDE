/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildThinkingIndicator,
	formatRelativeRu,
} from '../../common/aiThinkingIndicator.js';

suite('AI thinking indicator — pure label formatter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildThinkingIndicator phases', () => {
		test('idle → hidden', () => {
			const r = buildThinkingIndicator({ phase: 'idle' });
			assert.strictEqual(r.visible, false);
			assert.strictEqual(r.text, '');
		});

		test('thinking → info severity, spinner + RU label', () => {
			const r = buildThinkingIndicator({ phase: 'thinking' });
			assert.strictEqual(r.visible, true);
			assert.strictEqual(r.severity, 'info');
			assert.ok(r.text.includes('Думает'));
			assert.ok(r.text.includes('loading~spin'));
		});

		test('waiting → warn severity, «Ожидание ответа…»', () => {
			const r = buildThinkingIndicator({ phase: 'waiting' });
			assert.strictEqual(r.severity, 'warn');
			assert.ok(r.text.includes('Ожидание ответа'));
		});

		test('retrying-1 → попытка 1/2', () => {
			const r = buildThinkingIndicator({ phase: 'retrying-1' });
			assert.strictEqual(r.severity, 'warn');
			assert.ok(r.text.includes('1/2'));
		});

		test('retrying-2 → попытка 2/2', () => {
			const r = buildThinkingIndicator({ phase: 'retrying-2' });
			assert.ok(r.text.includes('2/2'));
		});

		test('failed (gap-timeout default) → error severity + reconnect hint', () => {
			const r = buildThinkingIndicator({ phase: 'failed' });
			assert.strictEqual(r.severity, 'error');
			assert.ok(r.text.includes('Соединение прервано'));
			assert.ok(r.hint && r.hint.includes('сеть'));
		});

		test('failed (cancelled) → отменён hint', () => {
			const r = buildThinkingIndicator({ phase: 'failed', failedReason: 'cancelled' });
			assert.ok(r.hint && r.hint.includes('отменён'));
		});

		test('failed (provider-error) → provider hint', () => {
			const r = buildThinkingIndicator({ phase: 'failed', failedReason: 'provider-error' });
			assert.ok(r.hint && r.hint.includes('Провайдер'));
		});

		test('completed → hidden', () => {
			const r = buildThinkingIndicator({ phase: 'completed' });
			assert.strictEqual(r.visible, false);
		});
	});

	suite('lastChunkAgoMs hint', () => {
		test('thinking + lastChunkAgoMs → Последняя активность hint', () => {
			const r = buildThinkingIndicator({ phase: 'thinking', lastChunkAgoMs: 12_000 });
			assert.ok(r.hint && r.hint.includes('Последняя активность'));
			assert.ok(r.hint.includes('12 секунд'));
		});

		test('waiting + lastChunkAgoMs', () => {
			const r = buildThinkingIndicator({ phase: 'waiting', lastChunkAgoMs: 30_000 });
			assert.ok(r.hint && r.hint.includes('30 секунд'));
		});

		test('lastChunkAgoMs <= 0 → no hint', () => {
			const r = buildThinkingIndicator({ phase: 'thinking', lastChunkAgoMs: 0 });
			assert.strictEqual(r.hint, undefined);
		});

		test('lastChunkAgoMs non-finite → no hint', () => {
			const r = buildThinkingIndicator({ phase: 'thinking', lastChunkAgoMs: NaN });
			assert.strictEqual(r.hint, undefined);
		});
	});

	suite('formatRelativeRu', () => {
		test('< 1s → «только что»', () => {
			assert.strictEqual(formatRelativeRu(500), 'только что');
		});

		test('1s → секунду назад', () => {
			assert.strictEqual(formatRelativeRu(1_000), '1 секунду назад');
		});

		test('2-4s → секунды назад', () => {
			assert.strictEqual(formatRelativeRu(3_000), '3 секунды назад');
		});

		test('5+ s → секунд', () => {
			assert.strictEqual(formatRelativeRu(7_000), '7 секунд назад');
		});

		test('11-14s → секунд (slavic special)', () => {
			assert.strictEqual(formatRelativeRu(12_000), '12 секунд назад');
			assert.strictEqual(formatRelativeRu(14_000), '14 секунд назад');
		});

		test('21s → секунду', () => {
			assert.strictEqual(formatRelativeRu(21_000), '21 секунду назад');
		});

		test('1 минуту', () => {
			assert.strictEqual(formatRelativeRu(60_000), '1 минуту назад');
		});

		test('3 минуты / 5 минут', () => {
			assert.strictEqual(formatRelativeRu(3 * 60_000), '3 минуты назад');
			assert.strictEqual(formatRelativeRu(5 * 60_000), '5 минут назад');
		});

		test('1 час', () => {
			assert.strictEqual(formatRelativeRu(60 * 60_000), '1 час назад');
		});

		test('2 часа / 5 часов', () => {
			assert.strictEqual(formatRelativeRu(2 * 60 * 60_000), '2 часа назад');
			assert.strictEqual(formatRelativeRu(5 * 60 * 60_000), '5 часов назад');
		});

		test('11 часов (slavic special)', () => {
			assert.strictEqual(formatRelativeRu(11 * 60 * 60_000), '11 часов назад');
		});
	});
});
