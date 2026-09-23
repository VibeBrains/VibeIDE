/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseVibeAgentsFile } from '../../common/acp/vibeAgentsFile.js';
import { EMPTY_AGENTS_FILE, rawAgentIndex, withAgentAppended, withAgentUpdated } from '../../common/acp/vibeAgentsFileEdit.js';

suite('vibeAgentsFileEdit — правка agents.json без потери комментариев', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const FILE = [
		'// team agents — keep this note',
		'{',
		'\t"version": 1,',
		'\t"agents": [',
		'\t\t{ "id": "broken" },',
		'\t\t// added from the registry',
		'\t\t{ "id": "mm", "name": "Наш MiniMax", "command": "npx", "args": ["@minimax-ai/code@0.2.6", "acp"], "mcpServers": ["vibememory"], "registry": { "id": "minimax-code", "version": "0.2.6" } }',
		'\t]',
		'}',
		'',
	].join('\n');

	test('добавление дописывает в конец и сохраняет комментарии; отсутствующий файл создаётся', () => {
		const entry = { id: 'fa', command: 'uvx', args: ['fast-agent-acp==0.10.1'], registry: { id: 'fast-agent', version: '0.10.1' } };
		const appended = withAgentAppended(FILE, entry);
		const created = withAgentAppended(undefined, entry);
		assert.deepStrictEqual({
			комментарии: appended.includes('// team agents — keep this note') && appended.includes('// added from the registry'),
			порядок: parseVibeAgentsFile(appended).agents.map(agent => agent.id),
			новыйФайл: parseVibeAgentsFile(created).agents,
			заготовка: parseVibeAgentsFile(EMPTY_AGENTS_FILE).agents,
		}, {
			комментарии: true,
			порядок: ['mm', 'fa'],
			новыйФайл: [entry],
			заготовка: [],
		});
	});

	test('обновление меняет только свои поля, битая запись не сбивает индекс', () => {
		const updated = withAgentUpdated(FILE, 'mm', { command: 'npx', args: ['@minimax-ai/code@0.2.7', 'acp'], registry: { id: 'minimax-code', version: '0.2.7' } })!;
		assert.deepStrictEqual({
			индекс: rawAgentIndex(FILE, 'mm'),
			запись: parseVibeAgentsFile(updated).agents[0],
			комментарий: updated.includes('// added from the registry'),
			нетТакого: withAgentUpdated(FILE, 'nobody', { command: 'x' }),
		}, {
			индекс: 1,
			// The name, the MCP servers — the person's — stay as they were.
			запись: { id: 'mm', name: 'Наш MiniMax', command: 'npx', args: ['@minimax-ai/code@0.2.7', 'acp'], mcpServers: ['vibememory'], registry: { id: 'minimax-code', version: '0.2.7' } },
			комментарий: true,
			нетТакого: undefined,
		});
	});
});
