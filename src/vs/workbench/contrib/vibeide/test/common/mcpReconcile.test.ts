/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KnownMCPServer, mcpServerFingerprint, reconcileMCPServers, unitePictures, WantedMCPServer, WindowPicture } from '../../common/mcpReconcile.js';
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

	test('disabled в записи — это «работает ли», а не «как запущен»: включение сервера не перезапускает его соседей', () => {
		assert.strictEqual(mcpServerFingerprint({ ...stub, disabled: true }, true), mcpServerFingerprint(stub, true));
	});
});

/**
 * Серверы общие для всех окон, а файл проекта у каждого окна свой: что запущено — объединение картин окон.
 * Без этого окно без проекта закрывало бы серверы окна с проектом, а два проекта с одним именем делили бы сервер.
 */
suite('unitePictures — картины окон как одна', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const shared: MCPConfigFileEntryJSON = { command: 'node', args: ['/shared/server.mjs'] };
	const billing: MCPConfigFileEntryJSON = { command: 'node', args: ['/billing/db.mjs'] };
	const shop: MCPConfigFileEntryJSON = { command: 'node', args: ['/shop/db.mjs'] };

	const picture = (entries: Record<string, MCPConfigFileEntryJSON>, enabledOfName: Record<string, boolean> = {}): WindowPicture => ({ entries, enabledOfName });
	const unite = (windows: Record<string, WindowPicture>, running: Record<string, string> = {}) =>
		unitePictures(new Map(Object.entries(windows)), running, true);

	test('окна с общим файлом согласны: сервер один, конфликтов нет', () => {
		assert.deepStrictEqual(
			unite({ a: picture({ shared }), b: picture({ shared }) }),
			{ entries: { shared }, enabledOfName: { shared: true }, conflictsOfWindow: { a: [], b: [] } },
		);
	});

	test('сервер проекта одного окна не закрывается синхронизацией окна без проекта', () => {
		const united = unite({ a: picture({ shared, db: billing }), b: picture({ shared }) });
		assert.deepStrictEqual({ names: Object.keys(united.entries), conflicts: united.conflictsOfWindow }, { names: ['shared', 'db'], conflicts: { a: [], b: [] } });
	});

	test('одно имя и разные запуски: остаётся запущенный, второе окно называется в конфликтах', () => {
		const united = unite(
			{ a: picture({ db: billing }), b: picture({ db: shop }) },
			{ db: mcpServerFingerprint(shop, true) },
		);
		assert.deepStrictEqual({ db: united.entries['db'], conflicts: united.conflictsOfWindow }, { db: shop, conflicts: { a: ['db'], b: [] } });
	});

	test('ничего не запущено — имя достаётся окну, заговорившему первым', () => {
		const united = unite({ a: picture({ db: billing }), b: picture({ db: shop }) });
		assert.deepStrictEqual({ db: united.entries['db'], conflicts: united.conflictsOfWindow }, { db: billing, conflicts: { a: [], b: ['db'] } });
	});

	test('окно закрылось — имя свободно, конфликт снят', () => {
		const united = unite({ b: picture({ db: shop }) }, { db: mcpServerFingerprint(billing, true) });
		assert.deepStrictEqual({ db: united.entries['db'], conflicts: united.conflictsOfWindow }, { db: shop, conflicts: { b: [] } });
	});

	test('список tools запуском не считается: окна, различающиеся только им, не спорят', () => {
		const united = unite({ a: picture({ shared: { ...shared, tools: ['read'] } }), b: picture({ shared }) });
		assert.deepStrictEqual(united.conflictsOfWindow, { a: [], b: [] });
	});

	test('включён ли сервер, решает окно, чья запись действует', () => {
		const united = unite({ a: picture({ db: billing }, { db: false }), b: picture({ db: shop }, { db: true }) }, { db: mcpServerFingerprint(shop, true) });
		assert.deepStrictEqual(united.enabledOfName, { db: true });
	});
});
