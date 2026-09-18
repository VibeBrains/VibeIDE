/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MCP_MIN_REFRESH_MS, parseCacheableMeta, refreshDelayMs } from '../../common/mcpCacheableResult.js';

const withMeta = (meta: unknown) => ({ tools: [], _meta: meta });

suite('mcpCacheableResult — срок годности списка от сервера', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('срок читается только у нового сервера и только числом; мусор — это «не обещал»', () => {
		assert.deepStrictEqual([
			parseCacheableMeta(withMeta({ 'io.modelcontextprotocol/ttlMs': 300000, 'io.modelcontextprotocol/cacheScope': ' session ' })),
			parseCacheableMeta(withMeta({ 'io.modelcontextprotocol/ttlMs': 60000 })),
			parseCacheableMeta(withMeta({ 'io.modelcontextprotocol/ttlMs': '60000' })),
			parseCacheableMeta(withMeta({ 'io.modelcontextprotocol/ttlMs': 0 })),
			parseCacheableMeta(withMeta({ 'io.modelcontextprotocol/ttlMs': Number.POSITIVE_INFINITY })),
			parseCacheableMeta({ tools: [] }),
			parseCacheableMeta(undefined),
		], [
			{ ttlMs: 300000, cacheScope: 'session' },
			{ ttlMs: 60000 },
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
