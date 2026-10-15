/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { McpMigrationIo, migrateLegacyMcpFile } from '../../common/mcpLegacyMigration.js';

/**
 * Перенос серверов из прежнего файла VibeIDE в общий `~/.vibe/mcp.json`.
 *
 * Проверяется порядок: общий файл пишется ПЕРВЫМ, прежний переименовывается ПОСЛЕ. Сбой между ними ничего не теряет,
 * а повтор не дублирует. Файловая система подставная: настоящая запись и переименование — в живой проверке.
 */
suite('mcpLegacyMigration — перенос из прежнего файла в общий', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const legacy = URI.file('/home/me/.vibeide/mcp.json');
	const shared = URI.file('/home/me/.vibe/mcp.json');
	const migrated = URI.file('/home/me/.vibeide/mcp.json.migrated');

	const node = { command: 'node', args: ['server.js'] };
	const memory = { command: '/bin/memory-mcp', cwd: '/home/me' };

	/** Файлы по пути, журнал действий и точки сбоя */
	class FakeIo implements McpMigrationIo {
		readonly files = new Map<string, string>();
		readonly log: string[] = [];
		failWrite = false;
		failMove = false;
		/** Другое окно переименовало файл первым: перенос падает, а файла уже нет */
		moveWinsRace = false;

		constructor(files: Record<string, string> = {}) {
			for (const [path, text] of Object.entries(files)) {
				this.files.set(URI.file(path).toString(), text);
			}
		}
		async exists(resource: URI): Promise<boolean> { return this.files.has(resource.toString()); }
		async read(resource: URI): Promise<string> {
			const text = this.files.get(resource.toString());
			if (text === undefined) { throw new Error(`нет файла ${resource.path}`); }
			return text;
		}
		async write(resource: URI, text: string): Promise<void> {
			if (this.failWrite) { throw new Error('диск полон'); }
			this.log.push(`write ${resource.path}`);
			this.files.set(resource.toString(), text);
		}
		async move(from: URI, to: URI): Promise<void> {
			if (this.moveWinsRace) {
				this.files.delete(from.toString());
				throw new Error('файла уже нет');
			}
			if (this.failMove) { throw new Error('нет прав'); }
			this.log.push(`move ${from.path} -> ${to.path}`);
			this.files.set(to.toString(), this.files.get(from.toString())!);
			this.files.delete(from.toString());
		}
		json(resource: URI): unknown { return JSON.parse(this.files.get(resource.toString())!); }
	}

	test('прежнего файла нет — ничего не происходит', async () => {
		const io = new FakeIo();
		assert.deepStrictEqual({ outcome: await migrateLegacyMcpFile(io, legacy, shared), log: io.log }, { outcome: { kind: 'none' }, log: [] });
	});

	test('общего файла нет — записи переезжают как были, прежний файл переименован, а не удалён', async () => {
		const original = JSON.stringify({ mcpServers: { memory, node } });
		const io = new FakeIo({ [legacy.path]: original });
		const outcome = await migrateLegacyMcpFile(io, legacy, shared);
		assert.deepStrictEqual(
			{ outcome, shared: io.json(shared), log: io.log, legacyLeft: await io.exists(legacy), kept: io.files.get(migrated.toString()) },
			{
				outcome: { kind: 'migrated', moved: ['memory', 'node'], conflicts: [], keptAs: 'mcp.json.migrated' },
				shared: { mcpServers: { memory, node } },
				log: [`write ${shared.path}`, `move ${legacy.path} -> ${migrated.path}`],
				legacyLeft: false,
				kept: original,
			},
		);
	});

	test('общий файл есть — недостающее добавляется, его записи и прочие ключи остаются, конфликт назван', async () => {
		const io = new FakeIo({
			[legacy.path]: JSON.stringify({ mcpServers: { atlassian: { command: 'old' }, node, memory } }),
			[shared.path]: JSON.stringify({ custom: 1, mcpServers: { atlassian: { command: 'mcp-atlassian' }, node } }),
		});
		const outcome = await migrateLegacyMcpFile(io, legacy, shared);
		assert.deepStrictEqual(
			{ outcome, shared: io.json(shared), kept: io.json(migrated) },
			{
				outcome: { kind: 'migrated', moved: ['memory'], conflicts: ['atlassian'], keptAs: 'mcp.json.migrated' },
				shared: { custom: 1, mcpServers: { atlassian: { command: 'mcp-atlassian' }, node, memory } },
				// the losing entry survives in the renamed file
				kept: { mcpServers: { atlassian: { command: 'old' }, node, memory } },
			},
		);
	});

	test('нечего переносить — общий файл не переписывается, прежний всё равно уходит в сторону', async () => {
		const io = new FakeIo({
			[legacy.path]: JSON.stringify({ mcpServers: { node } }),
			[shared.path]: JSON.stringify({ mcpServers: { node } }),
		});
		const outcome = await migrateLegacyMcpFile(io, legacy, shared);
		assert.deepStrictEqual({ outcome, log: io.log }, {
			outcome: { kind: 'migrated', moved: [], conflicts: [], keptAs: 'mcp.json.migrated' },
			log: [`move ${legacy.path} -> ${migrated.path}`],
		});
	});

	test('пустой прежний файл переименовывается молча: переносить нечего, читать его больше незачем', async () => {
		const io = new FakeIo({ [legacy.path]: '{ "mcpServers": {} }' });
		const outcome = await migrateLegacyMcpFile(io, legacy, shared);
		assert.deepStrictEqual(outcome, { kind: 'migrated', moved: [], conflicts: [], keptAs: 'mcp.json.migrated' });
	});

	test('занятое имя .migrated не затирается: следующий файл получает номер', async () => {
		const io = new FakeIo({ [legacy.path]: JSON.stringify({ mcpServers: { node } }), [migrated.path]: 'прежний перенос' });
		const outcome = await migrateLegacyMcpFile(io, legacy, shared);
		assert.deepStrictEqual(
			{ outcome, firstKept: io.files.get(migrated.toString()) },
			{ outcome: { kind: 'migrated', moved: ['node'], conflicts: [], keptAs: 'mcp.json.migrated-2' }, firstKept: 'прежний перенос' },
		);
	});

	test('повторный запуск после переноса ничего не делает', async () => {
		const io = new FakeIo({ [legacy.path]: JSON.stringify({ mcpServers: { node } }) });
		await migrateLegacyMcpFile(io, legacy, shared);
		const writes = io.log.length;
		assert.deepStrictEqual({ outcome: await migrateLegacyMcpFile(io, legacy, shared), grew: io.log.length > writes }, { outcome: { kind: 'none' }, grew: false });
	});

	test('прежний файл не разобрался — остаётся на месте, общий не тронут', async () => {
		const io = new FakeIo({ [legacy.path]: 'это не json' });
		assert.deepStrictEqual(
			{ outcome: await migrateLegacyMcpFile(io, legacy, shared), log: io.log, legacyLeft: await io.exists(legacy) },
			{ outcome: { kind: 'legacyUnreadable', problem: 'NOT_JSON' }, log: [], legacyLeft: true },
		);
	});

	test('нет секции mcpServers в прежнем файле — тоже остаётся на месте, с причиной', async () => {
		const io = new FakeIo({ [legacy.path]: '{"нет": "секции"}' });
		assert.deepStrictEqual(await migrateLegacyMcpFile(io, legacy, shared), { kind: 'legacyUnreadable', problem: 'NO_SECTION' });
	});

	test('общий файл не JSON — его нельзя затирать: ничего не пишется и не переименовывается', async () => {
		const io = new FakeIo({ [legacy.path]: JSON.stringify({ mcpServers: { node } }), [shared.path]: '{ битый' });
		assert.deepStrictEqual(
			{ outcome: await migrateLegacyMcpFile(io, legacy, shared), log: io.log, legacyLeft: await io.exists(legacy), shared: io.files.get(shared.toString()) },
			{ outcome: { kind: 'sharedUnreadable' }, log: [], legacyLeft: true, shared: '{ битый' },
		);
	});

	test('запись общего файла не удалась — прежний файл не тронут, записи целы', async () => {
		const io = new FakeIo({ [legacy.path]: JSON.stringify({ mcpServers: { node } }) });
		io.failWrite = true;
		const outcome = await migrateLegacyMcpFile(io, legacy, shared);
		assert.deepStrictEqual({ kind: outcome.kind, legacyLeft: await io.exists(legacy), sharedMade: await io.exists(shared) }, { kind: 'failed', legacyLeft: true, sharedMade: false });
	});

	test('переименование не удалось — общий файл уже записан, сбой назван, следующий запуск ничего не продублирует', async () => {
		const io = new FakeIo({ [legacy.path]: JSON.stringify({ mcpServers: { node } }) });
		io.failMove = true;
		const first = await migrateLegacyMcpFile(io, legacy, shared);
		io.failMove = false;
		const second = await migrateLegacyMcpFile(io, legacy, shared);
		assert.deepStrictEqual(
			{ first: first.kind, second, shared: io.json(shared) },
			{ first: 'failed', second: { kind: 'migrated', moved: [], conflicts: [], keptAs: 'mcp.json.migrated' }, shared: { mcpServers: { node } } },
		);
	});

	test('второе окно успело переименовать раньше — это не сбой: файла уже нет, как и просили', async () => {
		const io = new FakeIo({ [legacy.path]: JSON.stringify({ mcpServers: { node } }) });
		io.moveWinsRace = true;
		const outcome = await migrateLegacyMcpFile(io, legacy, shared);
		assert.strictEqual(outcome.kind, 'migrated');
	});
});
