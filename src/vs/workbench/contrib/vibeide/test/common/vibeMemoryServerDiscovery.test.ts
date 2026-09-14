/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { vibeMemoryServerPathSegments, withDiscoveredMemoryServer } from '../../common/vibeMemoryServerDiscovery.js';

/**
 * Общая память семейства подключается сама, если сервер установлен.
 * Запись пользователя с тем же именем сильнее находки.
 */
suite('vibeMemoryServerDiscovery — сервер памяти без ручной записи', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const found = { command: '/Users/me/.vibememory/bin/vibememory-mcp', homeDir: '/Users/me' };

	test('найденный сервер добавляется с агентом vibeide и домашним каталогом как рабочим', () => {
		assert.deepStrictEqual(
			withDiscoveredMemoryServer({ other: { command: 'x' } }, found),
			{
				other: { command: 'x' },
				vibememory: { command: '/Users/me/.vibememory/bin/vibememory-mcp', args: ['--agent', 'vibeide'], cwd: '/Users/me' },
			},
		);
	});

	test('своя запись пользователя не трогается, а без находки ничего не добавляется', () => {
		const own = { vibememory: { command: '/opt/vm', args: ['--agent', 'mine'] } };
		assert.deepStrictEqual(
			[withDiscoveredMemoryServer(own, found), withDiscoveredMemoryServer({}, undefined)],
			[own, {}],
		);
	});

	test('на Windows у бинаря расширение .exe', () => {
		assert.deepStrictEqual(
			[vibeMemoryServerPathSegments(false), vibeMemoryServerPathSegments(true)],
			[['.vibememory', 'bin', 'vibememory-mcp'], ['.vibememory', 'bin', 'vibememory-mcp.exe']],
		);
	});
});
