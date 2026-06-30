/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	resolveResponseLanguage,
	buildResponseLanguageDirective,
} from '../../common/vibeAgentResponseLanguageConfiguration.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Agent response language — pure helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('resolveResponseLanguage', () => {
		test('explicit ru → ru regardless of prompt', () => {
			assert.strictEqual(resolveResponseLanguage('ru', 'hello world'), 'ru');
		});
		test('explicit en → en regardless of prompt', () => {
			assert.strictEqual(resolveResponseLanguage('en', 'привет мир'), 'en');
		});
		test('auto + cyrillic prompt → ru', () => {
			assert.strictEqual(resolveResponseLanguage('auto', 'привет, как дела?'), 'ru');
		});
		test('auto + ascii prompt → en', () => {
			assert.strictEqual(resolveResponseLanguage('auto', 'hello, how are you?'), 'en');
		});
		test('mixed prompt with single Cyrillic char → ru', () => {
			assert.strictEqual(resolveResponseLanguage('auto', 'do this for тест'), 'ru');
		});
		test('unknown setting falls back to auto-detect', () => {
			assert.strictEqual(resolveResponseLanguage('something', 'привет'), 'ru');
			assert.strictEqual(resolveResponseLanguage(undefined, 'hello'), 'en');
			assert.strictEqual(resolveResponseLanguage(null, 'hello'), 'en');
		});
		test('case-insensitive setting', () => {
			assert.strictEqual(resolveResponseLanguage('RU', 'hello'), 'ru');
			assert.strictEqual(resolveResponseLanguage('En', 'привет'), 'en');
		});
	});

	suite('buildResponseLanguageDirective', () => {
		test('auto + ascii prompt → empty (model mirrors user naturally)', () => {
			assert.strictEqual(buildResponseLanguageDirective('auto', 'hello'), '');
		});
		test('auto + cyrillic prompt → ru directive (models drift to en)', () => {
			const out = buildResponseLanguageDirective('auto', 'привет');
			assert.ok(out.includes('русском'));
		});
		test('explicit en + cyrillic prompt → en directive', () => {
			const out = buildResponseLanguageDirective('en', 'привет');
			assert.ok(out.toLowerCase().includes('english'));
		});
		test('explicit ru + ascii prompt → ru directive', () => {
			const out = buildResponseLanguageDirective('ru', 'hello');
			assert.ok(out.includes('русском'));
		});
		test('directive mentions API names exception', () => {
			const ru = buildResponseLanguageDirective('ru', 'hello');
			const en = buildResponseLanguageDirective('en', 'hello');
			assert.ok(ru.includes('API'));
			assert.ok(en.includes('API'));
		});
	});
});
