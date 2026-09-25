/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeUnauthorizedHelper, helperHeadersOf, mergeServerEnv, transportRequestInit } from '../../common/mcpServerEnv.js';

/**
 * Переменная из записи MCP-сервера сильнее окружения IDE, но опасные имена из записи не проходят.
 * Заголовки записи доезжают до транспорта.
 */
suite('mcpServerEnv — окружение и заголовки MCP-сервера', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('запись сильнее окружения IDE, незаданные переменные окружения отброшены', () => {
		assert.deepStrictEqual(
			mergeServerEnv({ API_KEY: 'из-оболочки', HOME: '/Users/me', EMPTY: undefined }, { API_KEY: 'из-записи', EXTRA: '1' }),
			{ env: { API_KEY: 'из-записи', HOME: '/Users/me', EXTRA: '1' }, ignored: [] },
		);
	});

	test('критичные переменные из записи не применяются в любом регистре, окружение IDE остаётся', () => {
		assert.deepStrictEqual(
			mergeServerEnv({ PATH: '/usr/bin' }, { PATH: '/tmp/evil', Path: '/tmp/evil', ld_preload: '/tmp/x.so', NODE_OPTIONS: '--require x', OK: 'y' }),
			{ env: { PATH: '/usr/bin', OK: 'y' }, ignored: ['PATH', 'Path', 'ld_preload', 'NODE_OPTIONS'] },
		);
	});

	test('заголовки уходят в requestInit, без заголовков опции нет', () => {
		assert.deepStrictEqual(
			[transportRequestInit({ Authorization: 'Bearer t' }), transportRequestInit(undefined), transportRequestInit({})],
			[{ requestInit: { headers: { Authorization: 'Bearer t' } } }, {}, {}],
		);
	});

	test('помощник заголовков: только объект строк; 401 называет, где взять новый токен', () => {
		assert.deepStrictEqual([
			helperHeadersOf('{"Authorization":"Bearer vmt_1"}\n'),
			helperHeadersOf('{"Authorization":1}'),
			helperHeadersOf('["Bearer"]'),
			helperHeadersOf('{}'),
			helperHeadersOf('Bearer vmt_1'),
		], [{ Authorization: 'Bearer vmt_1' }, undefined, undefined, undefined, undefined]);
		const unauthorized = new Error('Failed to connect to HTTP server at https://vibememory.ru/mcp: Error POSTing to endpoint (HTTP 401): unauthorized');
		assert.deepStrictEqual([
			describeUnauthorizedHelper('vibememory-acme', unauthorized)?.includes('vibememory connect --agent vibeide'),
			describeUnauthorizedHelper('tracker', unauthorized)?.includes('headersHelper'),
			describeUnauthorizedHelper('vibememory-acme', new Error('HTTP 500')),
		], [true, true, undefined]);
	});
});
