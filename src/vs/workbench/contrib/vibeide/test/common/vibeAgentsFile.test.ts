/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { activeAgents, mergeAgentLayers, parseJetBrainsAcpFile, parseVibeAgentsFile, parseVibeAgentsFileOrEmpty } from '../../common/acp/vibeAgentsFile.js';
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

	test('происхождение из реестра хранится, кривое — отклоняется с жалобой', () => {
		const { agents, problems } = parseVibeAgentsFile(`{ "agents": [
			{ "id": "mm", "command": "npx", "args": ["@minimax-ai/code@0.2.7", "acp"], "registry": { "id": "minimax-code", "version": "0.2.7" } },
			{ "id": "bad", "command": "npx", "registry": { "id": "minimax-code" } }
		]}`);
		assert.deepStrictEqual([agents.map(agent => agent.registry), problems], [
			[{ id: 'minimax-code', version: '0.2.7' }],
			['запись "bad": "registry" — объект { "id", "version" } из реестра ACP'],
		]);
	});

	test('проектная запись сильнее машинной с тем же id, машинные идут следом', () => {
		const machine = [{ id: 'shared', command: '/usr/local/bin/mine' }, { id: 'local-only', command: '/opt/agent' }];
		const project = [{ id: 'shared', command: 'npx', args: ['team-agent@1.0.0'] }];
		assert.deepStrictEqual(mergeAgentLayers(machine, project).map(item => `${item.layer}:${item.agent.id}:${item.agent.command}`), [
			'project:shared:npx',
			'machine:local-only:/opt/agent',
		]);
	});

	test('~/.jetbrains/acp.json: имя — отображаемое, id из него; битая запись пропускается с жалобой', () => {
		assert.deepStrictEqual(parseJetBrainsAcpFile(`{
			"agent_servers": {
				"Claude Code": { "command": "/usr/local/bin/claude-agent-acp", "env": { "ANTHROPIC_LOG": "debug" } },
				"Gemini CLI": { "command": "gemini", "args": ["--experimental-acp"] },
				"Сломанный": { "args": ["acp"] },
				"!!!": { "command": "x" }
			}
		}`), {
			agents: [
				{ id: 'claude-code', name: 'Claude Code', command: '/usr/local/bin/claude-agent-acp', env: { ANTHROPIC_LOG: 'debug' } },
				{ id: 'gemini-cli', name: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'] },
			],
			problems: ['запись "сломанный": нет "command"', 'агент «!!!»: из имени не получается id'],
		});
		assert.deepStrictEqual([parseJetBrainsAcpFile(undefined), parseJetBrainsAcpFile('{"agents": []}').problems], [{ agents: [], problems: [] }, ['в файле нет объекта "agent_servers"']]);
	});

	test('агент JetBrains слабее обоих наших файлов и идёт последним', () => {
		const machine = [{ id: 'claude-code', command: '/opt/mine' }];
		const project = [{ id: 'team', command: 'npx' }];
		const jetbrains = [{ id: 'claude-code', command: '/usr/local/bin/claude-agent-acp' }, { id: 'gemini-cli', command: 'gemini' }];
		assert.deepStrictEqual(mergeAgentLayers(machine, project, jetbrains).map(item => `${item.layer}:${item.agent.id}:${item.agent.command}`), [
			'project:team:npx',
			'machine:claude-code:/opt/mine',
			'jetbrains:gemini-cli:gemini',
		]);
	});
});
