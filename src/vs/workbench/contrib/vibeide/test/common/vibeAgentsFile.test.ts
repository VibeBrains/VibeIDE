/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { activeAgents, parseVibeAgentsFile, parseVibeAgentsFileOrEmpty } from '../../common/acp/vibeAgentsFile.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('vibeAgentsFile', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('запись с комментариями разбирается целиком', () => {
		const result = parseVibeAgentsFile(`{
			// внешние агенты проекта
			"version": 1,
			"agents": [
				{
					"id": "claude",
					"name": "Claude Code",
					"command": "npx",
					"args": ["-y", "@agentclientprotocol/claude-agent-acp"],
					"env": { "ANTHROPIC_LOG": "debug" },
					"dir": "packages/web"
				}
			]
		}`);
		assert.deepStrictEqual(result, {
			problems: [],
			agents: [{
				id: 'claude',
				command: 'npx',
				name: 'Claude Code',
				args: ['-y', '@agentclientprotocol/claude-agent-acp'],
				env: { ANTHROPIC_LOG: 'debug' },
				dir: 'packages/web',
			}],
		});
	});

	test('битая запись пропускается, соседи живут', () => {
		const result = parseVibeAgentsFile(`{"agents": [
			{ "name": "без id", "command": "x" },
			{ "id": "нет команды" },
			{ "id": "двойник", "command": "a" },
			{ "id": "двойник", "command": "b" },
			{ "id": "живой", "command": "acp-agent" }
		]}`);
		assert.deepStrictEqual(
			[result.agents.map(agent => agent.id), result.problems.length],
			[['двойник', 'живой'], 3]);
	});

	test('беда верхнего уровня отключает файл целиком, а не половину', () => {
		assert.deepStrictEqual(
			[parseVibeAgentsFile('не json').agents, parseVibeAgentsFile('{"agents": 5}').agents],
			[[], []]);
	});

	test('args строкой не принимается: команда запускается без оболочки', () => {
		// «npx -y пакет» одним аргументом означало бы поиск файла с таким именем.
		const result = parseVibeAgentsFile(`{"agents": [{ "id": "a", "command": "npx", "args": "-y пакет" }]}`);
		assert.deepStrictEqual([result.agents, result.problems.length], [[], 1]);
	});

	test('отсутствие файла — не ошибка', () => {
		assert.deepStrictEqual(
			[parseVibeAgentsFileOrEmpty(undefined), parseVibeAgentsFileOrEmpty('   ')],
			[{ agents: [], problems: [] }, { agents: [], problems: [] }]);
	});

	test('выключенная запись остаётся документированной, но вне списка', () => {
		const { agents } = parseVibeAgentsFile(`{"agents": [
			{ "id": "спящий", "command": "a", "active": false },
			{ "id": "рабочий", "command": "b" }
		]}`);
		assert.deepStrictEqual([agents.length, activeAgents(agents).map(agent => agent.id)], [2, ['рабочий']]);
	});
});
