/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { effortWithinValues } from '../../common/reasoningEffortLevel.js';
import { readServedIdentity } from '../../common/modelEcho.js';
import { resolveReasoningEnabled } from '../../common/modelCapabilities.js';

/**
 * Уровень мышления не уходит к вендору, если модель его не принимает; отпечаток бэкенда читается из ответа.
 */
suite('reasoningEffortLevel — уровень в пределах модели', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('уровень модели остаётся, чужой — ближайший, ничья — вверх, усилитель — к своему уровню, незнакомое — умолчание', () => {
		const deepseek = ['low', 'high', 'max'];
		assert.deepStrictEqual([
			effortWithinValues('high', deepseek, 'high'),
			effortWithinValues(undefined, deepseek, 'high'),
			effortWithinValues('medium', deepseek, 'high'),
			effortWithinValues('minimal', deepseek, 'high'),
			// Таблица вендора: xhigh → high, ultra → max (guides/thinking_mode, 18.09.2026).
			effortWithinValues('xhigh', deepseek, 'high'),
			effortWithinValues('ultra', deepseek, 'high'),
			// Своего уровня у модели нет — работает прежнее правило расстояния.
			effortWithinValues('xhigh', ['low', 'max'], 'low'),
			effortWithinValues('adaptive', deepseek, 'high'),
			effortWithinValues('medium', ['adaptive', 'enabled'], 'adaptive'),
		], ['high', 'high', 'high', 'low', 'high', 'max', 'max', 'high', 'adaptive']);
	});

	test('модель без выключения мышления игнорирует сохранённое «выключено»', () => {
		assert.deepStrictEqual(
			[resolveReasoningEnabled(false, false, 'Chat'), resolveReasoningEnabled(undefined, false, 'Apply'), resolveReasoningEnabled(false, true, 'Chat'), resolveReasoningEnabled(undefined, true, 'Chat'), resolveReasoningEnabled(undefined, true, 'Apply')],
			[true, true, false, true, false],
		);
	});

	test('отпечаток бэкенда из того же чанка, что и модель', () => {
		assert.deepStrictEqual([
			readServedIdentity('data: {"id":"1","model":"deepseek-v4-pro","system_fingerprint":"a307abda","choices":[]}\n'),
			readServedIdentity('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5"}}\n'),
			readServedIdentity('data: {"model":"deepseek-flash","system_fingerprint":"aeb5'),
		], [
			{ model: 'deepseek-v4-pro', fingerprint: 'a307abda' },
			{ model: 'claude-sonnet-5' },
			{ model: 'deepseek-flash' },
		]);
	});
});
