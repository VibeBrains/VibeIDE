/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { teamServerOfSidecar, vibeMemoryEngine, vibeMemoryServerPathSegments, withDiscoveredMemoryServer, withDiscoveredTeamServers } from '../../common/vibeMemoryServerDiscovery.js';

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
			[['bin', 'vibememory-mcp'], ['bin', 'vibememory-mcp.exe']],
		);
	});

	test('каталог движка — как у CLI VibeMemory: VIBEMEMORY_DIR, пустая — не задана, относительная — от дома; переменная уходит серверу', () => {
		const home = URI.file('/Users/me');
		const engine = (value: string | undefined) => {
			const found = vibeMemoryEngine(home, value);
			return { dir: found.dir.path, env: found.env };
		};
		assert.deepStrictEqual([engine(undefined), engine(''), engine('/opt/vm'), engine('work/vm')], [
			{ dir: '/Users/me/.vibememory', env: undefined },
			{ dir: '/Users/me/.vibememory', env: undefined },
			{ dir: '/opt/vm', env: { VIBEMEMORY_DIR: URI.file('/opt/vm').fsPath } },
			{ dir: '/Users/me/work/vm', env: { VIBEMEMORY_DIR: URI.file('/Users/me/work/vm').fsPath } },
		]);
		assert.deepStrictEqual(withDiscoveredMemoryServer({}, { ...found, env: { VIBEMEMORY_DIR: '/opt/vm' } }).vibememory.env, { VIBEMEMORY_DIR: '/opt/vm' });
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
		assert.deepStrictEqual(withDiscoveredTeamServers({ 'vibememory-mine': { command: '/own' } }, teams, { command: '/home/me/.vibememory/bin/vibememory' }), {
			'vibememory-mine': { command: '/own' },
			'vibememory-acme': { type: 'http', url: 'https://vibememory.ru/mcp', headersHelper: { command: '/home/me/.vibememory/bin/vibememory', args: ['mcp-headers', 'acme', 'vibeide'], revision: 't-1' } },
		});
		// A moved engine folder reaches the helper, or it would look for the token where connect did not put it
		assert.deepStrictEqual(withDiscoveredTeamServers({}, teams.slice(0, 1), { command: '/opt/vm/bin/vibememory', env: { VIBEMEMORY_DIR: '/opt/vm' } }), {
			'vibememory-acme': { type: 'http', url: 'https://vibememory.ru/mcp', headersHelper: { command: '/opt/vm/bin/vibememory', args: ['mcp-headers', 'acme', 'vibeide'], env: { VIBEMEMORY_DIR: '/opt/vm' }, revision: 't-1' } },
		});
		// Without the helper there is no way to get the header, so no team is offered
		assert.deepStrictEqual(withDiscoveredTeamServers({}, teams, undefined), {});
	});
});
