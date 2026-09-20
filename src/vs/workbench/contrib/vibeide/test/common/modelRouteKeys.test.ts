/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { normalizeModelRoutes, resolveModelReference, routeKeyOf } from '../../common/modelRouteKeys.js';

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
			{ kind: 'unknown-key', key: 'missing' },
		]);
	});
});
