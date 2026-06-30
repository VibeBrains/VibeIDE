/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { stripStandaloneThinkDelimiters } from '../../common/helpers/stripThinkDelimiters.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('stripStandaloneThinkDelimiters', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('removes an orphan closing </think> on its own line', () => {
		// The observed leak: native reasoning channel + a lone </think> bleeding into content.
		const input = 'итог рассуждений\n\n</think>\n\nОтвет пользователю.';
		// Removing the lone-tag line leaves the surrounding blank lines (cosmetic; markdown collapses them).
		assert.strictEqual(
			stripStandaloneThinkDelimiters(input),
			'итог рассуждений\n\n\nОтвет пользователю.',
		);
	});

	test('removes orphan opening <think> and <thinking>/</thinking> variants', () => {
		assert.strictEqual(stripStandaloneThinkDelimiters('<think>\nbody'), 'body');
		assert.strictEqual(stripStandaloneThinkDelimiters('a\n</thinking>\nb'), 'a\nb');
		assert.strictEqual(stripStandaloneThinkDelimiters('  <THINK>  \nx'), 'x');
	});

	test('leaves inline mentions and code untouched', () => {
		// Not a bare line → must survive (e.g. discussing the literal tag in prose/code).
		const inline = 'модель шлёт </think> в тексте';
		assert.strictEqual(stripStandaloneThinkDelimiters(inline), inline);
		const code = 'const s = "</think>";';
		assert.strictEqual(stripStandaloneThinkDelimiters(code), code);
	});

	test('no delimiter → returned unchanged (fast path)', () => {
		const plain = 'обычный ответ\nбез тегов';
		assert.strictEqual(stripStandaloneThinkDelimiters(plain), plain);
		assert.strictEqual(stripStandaloneThinkDelimiters(''), '');
	});

	test('strips multiple standalone delimiters', () => {
		assert.strictEqual(
			stripStandaloneThinkDelimiters('</think>\nанализ\n</think>\nответ'),
			'анализ\nответ',
		);
	});
});
