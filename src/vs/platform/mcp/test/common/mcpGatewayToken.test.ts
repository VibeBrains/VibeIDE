/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { bearerTokenOf, tokenMatches, unauthorizedBody } from '../../common/mcpGatewayToken.js';

suite('mcpGatewayToken — пропуск к шлюзу', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('токен берётся только из схемы Bearer', () => {
		assert.deepStrictEqual([
			bearerTokenOf('Bearer abc123'),
			bearerTokenOf('bearer abc123'),
			bearerTokenOf('  Bearer   abc123  '),
			bearerTokenOf(['Bearer abc123', 'Bearer other']),
			bearerTokenOf('Basic abc123'),
			bearerTokenOf('abc123'),
			bearerTokenOf(undefined),
		], ['abc123', 'abc123', 'abc123', 'abc123', undefined, undefined, undefined]);
	});

	/** Сравнение идёт по всей длине: по времени ответа токен иначе подбирается посимвольно. */
	test('совпадает только точный токен; пустой ожидаемый не открывает дверь никому', () => {
		assert.deepStrictEqual([
			tokenMatches('a1b2c3', 'a1b2c3'),
			tokenMatches('a1b2c3', 'a1b2c4'),
			tokenMatches('a1b2c3', 'a1b2c'),
			tokenMatches('a1b2c3', undefined),
			tokenMatches('', undefined),
			tokenMatches('', ''),
		], [true, false, false, false, false, false]);
	});

	test('отказ называет файл, из которого берут токен', () => {
		const body = JSON.parse(unauthorizedBody('/Users/me/.vibe/mcp-gateway.token'));
		assert.deepStrictEqual(
			[body.error, body.error_description.includes('/Users/me/.vibe/mcp-gateway.token'), body.error_description.includes('Bearer')],
			['Unauthorized', true, true],
		);
	});
});
