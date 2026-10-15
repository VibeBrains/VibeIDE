/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MCPConfigFileEntryJSON } from '../../common/mcpServiceTypes.js';
import { mergeMcpLayers, parseMcpRoot, parseMcpServersFile, planMcpMigration, readMcpServersSection } from '../../common/mcpServersFile.js';

/**
 * Файл MCP-серверов семейства: один формат для VibeIDE и VibeIDEA.
 *
 * Главное здесь — что делает НЕПРАВИЛЬНЫЙ файл (сервер, пропавший молча, выглядит как сломанный инструмент)
 * и что переносимые записи не теряются. Случаи, где два продукта обязаны сойтись, лежат в общих векторах набора
 * (test/node/mcpServersFileVectors.test.ts) — здесь остальное.
 */
suite('mcpServersFile — общий файл MCP-серверов', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const node: MCPConfigFileEntryJSON = { command: 'node', args: ['server.js'] };
	const remote: MCPConfigFileEntryJSON = { url: 'https://mcp.example.com/mcp', type: 'http', headers: { 'X-Team': 'core' } };

	suite('разбор', () => {
		test('запись VibeIDE целиком проходит как есть: cwd, tools и заголовки не теряются', () => {
			const parsed = parseMcpServersFile(JSON.stringify({
				mcpServers: {
					memory: { command: '/bin/memory-mcp', cwd: '/home/me', tools: ['search'] },
					tracker: remote,
				},
			}));
			assert.deepStrictEqual(parsed, {
				servers: {
					memory: { command: '/bin/memory-mcp', cwd: '/home/me', tools: ['search'] },
					tracker: remote,
				},
				problems: [],
			});
		});

		test('выключатель нормализуется: true и строка «true» дают disabled: true, остальное поле убирает', () => {
			const parsed = parseMcpServersFile(JSON.stringify({
				mcpServers: {
					a: { command: 'x', disabled: true },
					b: { command: 'x', disabled: 'true' },
					c: { command: 'x', disabled: false },
					d: { command: 'x', disabled: 'yes' },
				},
			}));
			assert.deepStrictEqual(Object.fromEntries(Object.entries(parsed.servers).map(([name, entry]) => [name, entry.disabled])), {
				a: true, b: true, c: undefined, d: undefined,
			});
		});

		test('args и env приводятся к строкам, как это делает VibeIDEA', () => {
			const parsed = parseMcpServersFile(JSON.stringify({
				mcpServers: { x: { command: ' srv ', args: ['-p', 8080, true, null], env: { A: '1', B: 2, C: null } } },
			}));
			assert.deepStrictEqual(parsed.servers['x'], { command: 'srv', args: ['-p', '8080', 'true'], env: { A: '1', B: '2' } });
		});

		test('жалоба называет запись, остальные записи работают', () => {
			const parsed = parseMcpServersFile(JSON.stringify({
				mcpServers: { пустой: {}, строкой: 'node', оба: { command: 'node', url: 'https://x.example/mcp' }, рабочий: node },
			}));
			assert.deepStrictEqual(parsed, {
				servers: { рабочий: node },
				problems: [
					{ problem: 'NO_COMMAND', name: 'пустой' },
					{ problem: 'NOT_AN_OBJECT', name: 'строкой' },
					{ problem: 'AMBIGUOUS', name: 'оба' },
				],
			});
		});

		test('битый файл жалуется целиком и не притворяется, что серверов нет', () => {
			assert.deepStrictEqual(
				['это не json', '[]', '{"нет": "секции"}', '{"mcpServers": []}'].map(text => parseMcpServersFile(text).problems),
				[[{ problem: 'NOT_JSON' }], [{ problem: 'NOT_JSON' }], [{ problem: 'NO_SECTION' }], [{ problem: 'NO_SECTION' }]],
			);
		});

		test('корень файла читается и без секции: прочие ключи общего файла переносу не мешают', () => {
			assert.deepStrictEqual(parseMcpRoot('{"custom": 1}'), { custom: 1 });
			assert.strictEqual(parseMcpRoot('не json'), undefined);
			assert.strictEqual(parseMcpRoot('[]'), undefined);
			assert.deepStrictEqual(readMcpServersSection('{"custom": 1}'), { kind: 'problem', problem: 'NO_SECTION' });
		});
	});

	suite('слои', () => {
		test('запись проекта заменяет запись общего файла целиком, а не по полям', () => {
			const merged = mergeMcpLayers([
				{ source: 'user', servers: { a: node, b: { command: 'node', env: { K: 'v' } } } },
				{ source: 'project', servers: { b: { command: 'npx', args: ['pkg'] }, c: remote } },
			]);
			assert.deepStrictEqual(merged, {
				servers: { a: node, b: { command: 'npx', args: ['pkg'] }, c: remote },
				sourceOfName: { a: 'user', b: 'project', c: 'project' },
				overridden: ['b'],
			});
		});

		test('имена сравниваются точно: «GitHub» и «github» — два сервера', () => {
			const merged = mergeMcpLayers([
				{ source: 'user', servers: { GitHub: node } },
				{ source: 'project', servers: { github: node } },
			]);
			assert.deepStrictEqual({ names: Object.keys(merged.servers), overridden: merged.overridden }, { names: ['GitHub', 'github'], overridden: [] });
		});

		test('слоёв нет — серверов нет', () => {
			assert.deepStrictEqual(mergeMcpLayers([]), { servers: {}, sourceOfName: {}, overridden: [] });
		});
	});

	suite('перенос из старого файла', () => {
		test('в общем файле нет серверов — переезжают все записи как были, лишние поля тоже', () => {
			const legacy = { memory: { command: '/bin/memory-mcp', cwd: '/home/me' }, tracker: remote };
			const plan = planMcpMigration(legacy, undefined);
			assert.deepStrictEqual(plan, { root: { mcpServers: legacy }, moved: ['memory', 'tracker'], same: [], conflicts: [] });
		});

		test('общий файл первичен: его записи и прочие ключи остаются, переезжает только недостающее', () => {
			const plan = planMcpMigration(
				{ old: node, shared: node },
				{ custom: { keep: true }, mcpServers: { shared: node, mine: remote } },
			);
			assert.deepStrictEqual(plan, {
				root: { custom: { keep: true }, mcpServers: { shared: node, mine: remote, old: node } },
				moved: ['old'],
				same: ['shared'],
				conflicts: [],
			});
		});

		test('одно имя и другая запись — конфликт: запись общего файла не затирается, конфликт называется', () => {
			const plan = planMcpMigration({ atlassian: { command: 'old-cmd' } }, { mcpServers: { atlassian: { command: 'new-cmd' } } });
			assert.deepStrictEqual(plan, {
				root: { mcpServers: { atlassian: { command: 'new-cmd' } } },
				moved: [],
				same: [],
				conflicts: ['atlassian'],
			});
		});

		test('та же запись в другом порядке ключей — не конфликт', () => {
			const plan = planMcpMigration(
				{ x: { command: 'node', args: ['a'], env: { A: '1', B: '2' } } },
				{ mcpServers: { x: { env: { B: '2', A: '1' }, args: ['a'], command: 'node' } } },
			);
			assert.deepStrictEqual({ same: plan.same, conflicts: plan.conflicts }, { same: ['x'], conflicts: [] });
		});

		test('повторный перенос ничего не двигает и не дублирует', () => {
			const legacy = { a: node, b: remote };
			const first = planMcpMigration(legacy, undefined);
			const second = planMcpMigration(legacy, first.root);
			assert.deepStrictEqual({ moved: second.moved, same: second.same, root: second.root }, { moved: [], same: ['a', 'b'], root: first.root });
		});

		test('общий файл без секции: ключи сохраняются, секция создаётся', () => {
			const plan = planMcpMigration({ a: node }, { custom: 1 });
			assert.deepStrictEqual(plan.root, { custom: 1, mcpServers: { a: node } });
		});
	});
});
