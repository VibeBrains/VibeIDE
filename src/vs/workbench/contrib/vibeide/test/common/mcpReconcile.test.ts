/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KnownMCPServer, mcpServerFingerprint, reconcileMCPServers, WantedMCPServer } from '../../common/mcpReconcile.js';
import { MCPConfigFileEntryJSON } from '../../common/mcpServiceTypes.js';

/**
 * Главный процесс сверяет запущенные MCP-серверы с картиной окна, а не верит диффу окна.
 * Перезагруженное окно начинает с пустого состояния; раньше каждый работающий сервер для него был
 * «добавленным» и запускался второй раз, а прежний процесс оставался жить.
 */
suite('mcpReconcile — сверка запущенных MCP-серверов с желаемыми', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const stub: MCPConfigFileEntryJSON = { command: 'node', args: ['/stub/server.mjs'], env: { TOKEN: 'a' } };
	const memory: MCPConfigFileEntryJSON = { command: '/Users/me/.vibememory/bin/vibememory-mcp', args: ['--agent', 'vibeide'] };
	const remote: MCPConfigFileEntryJSON = { url: 'https://mcp.example.com/mcp', headers: { 'X-Team': 'core' } };

	const running = (entry: MCPConfigFileEntryJSON, apps = true): KnownMCPServer => ({ fingerprint: mcpServerFingerprint(entry, apps), running: true });
	const stopped = (entry: MCPConfigFileEntryJSON, apps = true): KnownMCPServer => ({ fingerprint: mcpServerFingerprint(entry, apps), running: false });
	const on = (entry: MCPConfigFileEntryJSON, apps = true): WantedMCPServer => ({ fingerprint: mcpServerFingerprint(entry, apps), isOn: true });
	const off = (entry: MCPConfigFileEntryJSON, apps = true): WantedMCPServer => ({ fingerprint: mcpServerFingerprint(entry, apps), isOn: false });

	test('перезагруженное окно просит то, что уже работает, — ничего не запускается заново', () => {
		assert.deepStrictEqual(
			reconcileMCPServers({ stub: running(stub), memory: running(memory) }, { stub: on(stub), memory: on(memory) }),
			{ stub: 'keep', memory: 'keep' },
		);
	});

	test('правка записи перезапускает только этот сервер; порядок ключей в mcp.json правкой не считается', () => {
		const reordered: MCPConfigFileEntryJSON = { env: { TOKEN: 'a' }, args: ['/stub/server.mjs'], command: 'node' };
		const changed: MCPConfigFileEntryJSON = { ...memory, args: ['--agent', 'vibeide', '--verbose'] };
		assert.deepStrictEqual(
			reconcileMCPServers({ stub: running(stub), memory: running(memory) }, { stub: on(reordered), memory: on(changed) }),
			{ stub: 'keep', memory: 'restart' },
		);
	});

	test('список tools записи — фильтр окна, а не часть запуска: его правка сервер не перезапускает', () => {
		assert.deepStrictEqual(
			reconcileMCPServers({ stub: running(stub) }, { stub: on({ ...stub, tools: ['read_note'] }) }),
			{ stub: 'keep' },
		);
	});

	test('выключенный сервер не запускается и не работает, включённый запускается', () => {
		assert.deepStrictEqual(
			reconcileMCPServers(
				{ stub: running(stub), memory: stopped(memory) },
				{ stub: off(stub), memory: on(memory), remote: off(remote) },
			),
			{ stub: 'off', memory: 'start', remote: 'off' },
		);
	});

	test('упавший при запуске сервер пробуется снова, новый включённый — запускается', () => {
		assert.deepStrictEqual(
			reconcileMCPServers({ remote: stopped(remote) }, { remote: on(remote), stub: on(stub) }),
			{ remote: 'start', stub: 'start' },
		);
	});

	test('сервер, убранный из mcp.json, закрывается и забывается', () => {
		assert.deepStrictEqual(
			reconcileMCPServers({ stub: running(stub), remote: stopped(remote) }, { memory: on(memory) }),
			{ memory: 'start', stub: 'remove', remote: 'remove' },
		);
	});

	test('смена возможности MCP Apps перезапускает работающие серверы: клиент объявляет её при подключении', () => {
		assert.deepStrictEqual(
			reconcileMCPServers({ stub: running(stub, false) }, { stub: on(stub, true) }),
			{ stub: 'restart' },
		);
	});

	test('адрес объектом URL и тот же адрес строкой — один и тот же запуск', () => {
		const asObject = { ...remote, url: new URL('https://mcp.example.com/mcp') } as unknown as MCPConfigFileEntryJSON;
		assert.strictEqual(mcpServerFingerprint(asObject, true), mcpServerFingerprint(remote, true));
	});
});
