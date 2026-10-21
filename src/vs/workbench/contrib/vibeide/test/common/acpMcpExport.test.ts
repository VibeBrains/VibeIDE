/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildAcpMcpServers, isHttpAcpMcpServer } from '../../common/acp/acpMcpExport.js';

suite('acpMcpExport — какие MCP-серверы получает гостевой ACP-агент', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const entries = {
		fs: { command: '/bin/mcp-fs', args: ['--stdio'], env: { API_KEY: 'secret' } },
		docs: { url: 'https://mcp.example.com/mcp', type: 'http' as const, headers: { Authorization: 'Bearer t' } },
		legacy: { url: 'https://events.example.com/mcp', type: 'sse' as const },
		guarded: { command: '/bin/mcp-jira', tools: ['search'] },
		broken: { args: ['--stdio'] },
		off: { command: '/bin/mcp-off' },
		team: { url: 'https://vibememory.ru/mcp', type: 'http' as const, headersHelper: { command: '/home/me/.vibememory/bin/vibememory', args: ['mcp-headers', 'acme', 'vibeide'] } },
	};

	test('уезжает только названное, и в той форме, какую ждёт ACP', () => {
		const result = buildAcpMcpServers({
			entries,
			allowed: ['fs', 'docs'],
			isEnabled: () => true,
		});
		assert.deepStrictEqual({ servers: result.servers, skipped: result.skipped }, {
			servers: [
				// env и headers у ACP — списки пар, а не объекты.
				{ name: 'fs', command: '/bin/mcp-fs', args: ['--stdio'], env: [{ name: 'API_KEY', value: 'secret' }] },
				{ type: 'http', name: 'docs', url: 'https://mcp.example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] },
			],
			skipped: [],
		});
	});

	test('каждый пропуск назван причиной', () => {
		const result = buildAcpMcpServers({
			entries,
			allowed: ['guarded', 'legacy', 'broken', 'off', 'нет-такого', 'team'],
			isEnabled: name => name !== 'off',
		});
		assert.deepStrictEqual({
			servers: result.servers.length,
			причины: result.skipped.map(s => s.name),
			// Сервер со списком разрешённых инструментов не уезжает: на гостя наш список не
			// действует, и экспорт снял бы ограничение, которое человек написал руками.
			проОграничение: result.skipped.find(s => s.name === 'guarded')?.reason.includes('ограничение'),
			// The helper's header is a credential issued to the IDE: the guest would get the server without it
			проПомощника: result.skipped.find(s => s.name === 'team')?.reason.includes('headersHelper'),
		}, {
			servers: 0,
			причины: ['guarded', 'legacy', 'broken', 'off', 'нет-такого', 'team'],
			проОграничение: true,
			проПомощника: true,
		});
	});

	test('пустой список не отдаёт ничего', () => {
		assert.deepStrictEqual(buildAcpMcpServers({ entries, allowed: [], isEnabled: () => true }), { servers: [], skipped: [] });
	});

	test('списка нет — гость получает все серверы файла, которые можно передать, а остальные названы причиной', () => {
		// Живой случай: сервер подключён в IDE, у агента из реестра поля mcpServers нет, и гость раньше не получал ничего
		const result = buildAcpMcpServers({ entries, allowed: undefined, isEnabled: name => name !== 'off' });
		assert.deepStrictEqual({
			уехали: result.servers.map(server => server.name),
			причины: result.skipped.map(s => s.name),
		}, {
			уехали: ['fs', 'docs'],
			// Выключенный `off` тут не назван: его никто не просил по имени, и для гостя его нет, как нет и для IDE
			причины: ['legacy', 'guarded', 'broken', 'team'],
		});
	});

	test('список по имени строже умолчания: выключенный сервер, названный в списке, объяснён', () => {
		const named = buildAcpMcpServers({ entries, allowed: ['off', 'fs'], isEnabled: name => name !== 'off' });
		assert.deepStrictEqual({
			уехали: named.servers.map(server => server.name),
			причины: named.skipped.map(s => `${s.name}: ${s.reason}`),
		}, {
			уехали: ['fs'],
			причины: ['off: сервер выключен в настройках'],
		});
	});

	test('HTTP-запись узнаётся — её отсеивают у агента без такой поддержки', () => {
		const { servers } = buildAcpMcpServers({ entries, allowed: ['fs', 'docs'], isEnabled: () => true });
		assert.deepStrictEqual(servers.map(isHttpAcpMcpServer), [false, true]);
	});
});
