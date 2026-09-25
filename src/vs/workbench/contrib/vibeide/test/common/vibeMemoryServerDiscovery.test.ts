/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { teamServerOfSidecar, vibeMemoryServerPathSegments, withDiscoveredMemoryServer, withDiscoveredTeamServers } from '../../common/vibeMemoryServerDiscovery.js';

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

	test('память команды: сайдкар этого агента с https — сервер с помощником и ревизией токена; чужое — пропуск с причиной', () => {
		const sidecar = (fields: object) => JSON.stringify({ cabinet: 'https://app.vibememory.ru', team: 'acme', agent: 'vibeide', tokenId: 't-1', mcpUrl: 'https://vibememory.ru/mcp', ...fields });
		const verdict = (folder: string, text: string) => {
			const found = teamServerOfSidecar(folder, text);
			return 'skipped' in found ? 'пропуск' : found;
		};
		assert.deepStrictEqual([
			verdict('acme', sidecar({})),
			verdict('acme', sidecar({ mcpUrl: 'http://127.0.0.1:8787/mcp' })),
			verdict('acme', sidecar({ mcpUrl: 'http://vibememory.ru/mcp' })),
			verdict('acme', sidecar({ agent: 'vibeidea' })),
			verdict('acme', sidecar({ team: 'other' })),
			verdict('Acme Team', sidecar({})),
			verdict('acme', 'не json'),
		], [
			{ team: 'acme', url: 'https://vibememory.ru/mcp', tokenId: 't-1' },
			{ team: 'acme', url: 'http://127.0.0.1:8787/mcp', tokenId: 't-1' },
			'пропуск', 'пропуск', 'пропуск', 'пропуск', 'пропуск',
		]);
		const teams = [{ team: 'acme', url: 'https://vibememory.ru/mcp', tokenId: 't-1' }, { team: 'mine', url: 'https://vibememory.ru/mcp' }];
		assert.deepStrictEqual(withDiscoveredTeamServers({ 'vibememory-mine': { command: '/own' } }, teams, '/home/me/.vibememory/bin/vibememory'), {
			'vibememory-mine': { command: '/own' },
			'vibememory-acme': { type: 'http', url: 'https://vibememory.ru/mcp', headersHelper: { command: '/home/me/.vibememory/bin/vibememory', args: ['mcp-headers', 'acme', 'vibeide'], revision: 't-1' } },
		});
		// Without the helper there is no way to get the header, so no team is offered
		assert.deepStrictEqual(withDiscoveredTeamServers({}, teams, undefined), {});
	});
});
