/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MCP_MIN_REFRESH_MS, parseCacheableMeta, refreshDelayMs } from '../../common/mcpCacheableResult.js';

/** Форма ответа из спеки: поля срока лежат рядом с `tools`, а не в `_meta`. */
const listResult = (fields: Record<string, unknown>) => ({ resultType: 'complete', tools: [], nextCursor: 'c', ...fields });

suite('mcpCacheableResult — срок годности списка от сервера', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('срок читается из корня результата и только числом; мусор — это «не обещал»', () => {
		assert.deepStrictEqual([
			parseCacheableMeta(listResult({ ttlMs: 300000, cacheScope: 'public' })),
			parseCacheableMeta(listResult({ ttlMs: 60000 })),
			// Своих слов спека не допускает: чужая область читается как «не сказал», а не как истина.
			parseCacheableMeta(listResult({ ttlMs: 60000, cacheScope: 'session' })),
			parseCacheableMeta(listResult({ ttlMs: '60000' })),
			parseCacheableMeta(listResult({ ttlMs: 0 })),
			parseCacheableMeta(listResult({ ttlMs: Number.POSITIVE_INFINITY })),
			// Прежняя попытка читала `_meta` — сервер ревизии кладёт поля не туда.
			parseCacheableMeta({ tools: [], _meta: { 'io.modelcontextprotocol/ttlMs': 300000 } }),
			parseCacheableMeta(listResult({})),
			parseCacheableMeta(undefined),
		], [
			{ ttlMs: 300000, cacheScope: 'public' },
			{ ttlMs: 60000 },
			{ ttlMs: 60000 },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	/** Сервер с `ttlMs: 1` превратил бы чтение по сроку в опрос — порог держит это в рамках. */
	test('перечитывание не чаще порога', () => {
		assert.deepStrictEqual(
			[refreshDelayMs({ ttlMs: 1 }), refreshDelayMs({ ttlMs: MCP_MIN_REFRESH_MS * 10 })],
			[MCP_MIN_REFRESH_MS, MCP_MIN_REFRESH_MS * 10],
		);
	});
});
