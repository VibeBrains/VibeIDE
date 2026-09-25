/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mergeModelRoutes, normalizeModelRoutes, resolveModelReference, routeKeyOf } from '../../common/modelRouteKeys.js';

const routes = normalizeModelRoutes({ fast: ' openai/gpt-5.6-terra ', '@smart': 'anthropic/claude-opus-5', broken: '  ', '': 'x' });

suite('modelRouteKeys — логическое имя модели вместо конкретной', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('таблица чистится: пустые имена и значения выбрасываются, префикс в ключе не обязателен', () => {
		assert.deepStrictEqual(routes, { fast: 'openai/gpt-5.6-terra', smart: 'anthropic/claude-opus-5' });
	});

	test('ключ отличается от имени модели префиксом', () => {
		assert.deepStrictEqual(
			[routeKeyOf('@fast'), routeKeyOf('fast'), routeKeyOf('@'), routeKeyOf(undefined)],
			['fast', undefined, undefined, undefined],
		);
	});

	/** Неизвестное имя не подставляется ничем: работа не той моделью хуже остановки. */
	test('ключ разворачивается по таблице, обычное имя идёт как есть, неизвестное — отдельный исход', () => {
		assert.deepStrictEqual([
			resolveModelReference('@fast', routes),
			resolveModelReference('anthropic/claude-sonnet-5', routes),
			resolveModelReference('@missing', routes),
		], [
			{ kind: 'model', reference: 'openai/gpt-5.6-terra' },
			{ kind: 'model', reference: 'anthropic/claude-sonnet-5' },
			{ kind: 'unknown-key', key: 'missing', known: ['fast', 'smart'] },
		]);
	});

	/** `null` — имя объявлено и закрыто: слой ниже не может его вернуть, а шаг не может его взять. */
	test('слои складываются по порядку, null — запрет, который переживает слияние', () => {
		const merged = mergeModelRoutes([
			{ fast: 'openai/gpt-6-luna', vision: 'google/gemini-3.8-flash', smart: 'anthropic/claude-opus-5' },
			{ fast: 'minimax/MiniMax-M3', vision: null },
			normalizeModelRoutes({ '@smart': 'anthropic/claude-opus-5-5' }),
		]);
		assert.deepStrictEqual({ merged, vision: resolveModelReference('@vision', merged) }, {
			merged: { fast: 'minimax/MiniMax-M3', vision: null, smart: 'anthropic/claude-opus-5-5' },
			vision: { kind: 'disabled', key: 'vision' },
		});
	});
});
