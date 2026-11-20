/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ChatModeChoice,
	ChatPermissionMode,
	IToolApprovalContext,
	IToolCallFacts,
	chatModeChoiceOf,
	decideToolApproval,
	effectivePermissionMode,
	migratedPermissionMode,
	permissionModeOfThreadConfig,
	settingsOfChatModeChoice,
	softCheckpointIterationsFor,
	toolCallFactsOf,
} from '../../common/chatPermissionMode.js';

suite('режимы разрешений', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const roots = ['/work/proj'];
	const contextOf = (mode: ChatPermissionMode, overrides: Partial<IToolApprovalContext> = {}): IToolApprovalContext => ({
		mode,
		roots,
		caseInsensitivePaths: false,
		grants: { terminal: false, mcp: false },
		confirmDestructiveCommands: true,
		...overrides,
	});
	const verdict = (facts: IToolCallFacts, context: IToolApprovalContext): string => {
		const decision = decideToolApproval(facts, context);
		return `${decision.action}:${decision.reason}`;
	};
	const insideRead: IToolCallFacts = { kind: 'read', paths: ['/work/proj/a.ts'] };
	const insideEdit: IToolCallFacts = { kind: 'edit', paths: ['/work/proj/a.ts'] };
	const insideDelete: IToolCallFacts = { kind: 'delete', paths: ['/work/proj/a.ts'] };
	const wordlessCommand: IToolCallFacts = { kind: 'command', paths: [] };
	const mcp: IToolCallFacts = { kind: 'mcp', paths: [] };

	test('каждый режим решает read, edit, delete, command и mcp внутри проекта по-своему', () => {
		const actual = (['manual', 'edits', 'auto', 'bypass'] as const).map(mode =>
			[insideRead, insideEdit, insideDelete, wordlessCommand, mcp].map(facts => verdict(facts, contextOf(mode))));
		assert.deepStrictEqual(actual, [
			['allow:readInsideProject', 'ask:modeManual', 'ask:modeManual', 'ask:modeManual', 'ask:modeManual'],
			['allow:readInsideProject', 'allow:modeEdits', 'ask:modeEdits', 'ask:modeEdits', 'ask:modeEdits'],
			['allow:readInsideProject', 'allow:modeAuto', 'allow:modeAuto', 'allow:modeAuto', 'allow:modeAuto'],
			['allow:bypass', 'allow:bypass', 'allow:bypass', 'allow:bypass', 'allow:bypass'],
		]);
	});

	test('правка вне проекта спрашивается в auto и проходит в bypass', () => {
		const outside: IToolCallFacts = { kind: 'edit', paths: ['/elsewhere/a.ts'] };
		assert.deepStrictEqual([verdict(outside, contextOf('auto')), verdict(outside, contextOf('bypass'))], ['ask:outsideProject', 'allow:bypass']);
	});

	test('чтение вне проекта во «Вручную» спрашивается', () => {
		const outside: IToolCallFacts = { kind: 'read', paths: ['/elsewhere/notes.md'] };
		assert.deepStrictEqual([verdict(outside, contextOf('manual'))], ['ask:outsideProject']);
	});

	test('регистр пути учитывается только когда система его не различает', () => {
		const facts: IToolCallFacts = { kind: 'edit', paths: ['/work/PROJ/src/a.ts'] };
		assert.deepStrictEqual(
			[verdict(facts, contextOf('manual', { caseInsensitivePaths: true })), verdict(facts, contextOf('manual', { caseInsensitivePaths: false }))],
			['ask:modeManual', 'ask:outsideProject']);
	});

	test('правка высокого риска спрашивается в «Принимать правки» и проходит в auto', () => {
		const risky: IToolCallFacts = { kind: 'edit', paths: ['/work/proj/a.ts'], editRisk: 'HIGH' };
		assert.deepStrictEqual([verdict(risky, contextOf('edits')), verdict(risky, contextOf('auto'))], ['ask:highRiskEdit', 'allow:modeAuto']);
	});

	test('разрушительная команда спрашивается в auto и bypass, а без подтверждений решается режимом', () => {
		const command: IToolCallFacts = { kind: 'command', paths: [], command: 'rm -rf build' };
		assert.deepStrictEqual(
			[
				verdict(command, contextOf('auto')),
				verdict(command, contextOf('bypass')),
				verdict(command, contextOf('auto', { confirmDestructiveCommands: false })),
				verdict(command, contextOf('bypass', { confirmDestructiveCommands: false })),
			],
			['ask:destructive', 'ask:destructive', 'allow:modeAuto', 'allow:bypass']);
	});

	test('корень диска и домашняя папка спрашиваются даже в bypass при выключенных подтверждениях', () => {
		const commands: IToolCallFacts[] = [
			{ kind: 'command', paths: [], command: 'rm -rf /' },
			{ kind: 'command', paths: [], command: 'rm -rf ~' },
		];
		const contexts = [contextOf('bypass'), contextOf('bypass', { confirmDestructiveCommands: false })];
		assert.deepStrictEqual(
			commands.flatMap(command => contexts.map(context => verdict(command, context))),
			['ask:criticalPath', 'ask:criticalPath', 'ask:criticalPath', 'ask:criticalPath']);
	});

	test('чтение системного файла в auto спрашивается как путь вне проекта', () => {
		const command: IToolCallFacts = { kind: 'command', paths: [], command: 'cat /etc/hosts' };
		assert.deepStrictEqual([verdict(command, contextOf('auto'))], ['ask:commandOutsideProject']);
	});

	test('команда без текста решается режимом, а разрешение терминала снимает вопрос', () => {
		assert.deepStrictEqual(
			[
				verdict(wordlessCommand, contextOf('auto')),
				verdict(wordlessCommand, contextOf('manual')),
				verdict(wordlessCommand, contextOf('manual', { grants: { terminal: true, mcp: false } })),
			],
			['allow:modeAuto', 'ask:modeManual', 'allow:grant']);
	});

	test('разрешение MCP снимает вопрос, а без него «Принимать правки» спрашивает', () => {
		assert.deepStrictEqual(
			[
				verdict(mcp, contextOf('manual', { grants: { terminal: false, mcp: true } })),
				verdict(mcp, contextOf('edits')),
			],
			['allow:grant', 'ask:modeEdits']);
	});

	test('пункт списка и настройки переводятся туда и обратно для всех семи', () => {
		const choices: ChatModeChoice[] = ['normal', 'gather', 'plan', 'manual', 'edits', 'auto', 'bypass'];
		const roundTrip = choices.map(choice => {
			const settings = settingsOfChatModeChoice(choice, 'manual');
			return chatModeChoiceOf(settings.chatMode, settings.permissionMode);
		});
		assert.deepStrictEqual(roundTrip, choices);
	});

	test('чат-режимы сохраняют прежний режим разрешений, остальные включают agent со своим режимом', () => {
		const choices: ChatModeChoice[] = ['normal', 'gather', 'plan', 'manual', 'edits', 'auto', 'bypass'];
		assert.deepStrictEqual(
			choices.map(choice => {
				const settings = settingsOfChatModeChoice(choice, 'edits');
				return [settings.chatMode, settings.permissionMode];
			}),
			[
				['normal', 'edits'], ['gather', 'edits'], ['plan', 'edits'],
				['agent', 'manual'], ['agent', 'edits'], ['agent', 'auto'], ['agent', 'bypass'],
			]);
	});

	test('эффективный режим вне agent — всегда «Вручную», пауза зависит от автономности', () => {
		assert.deepStrictEqual(
			[
				effectivePermissionMode('normal', 'bypass'),
				effectivePermissionMode('plan', 'auto'),
				effectivePermissionMode('agent', 'auto'),
				softCheckpointIterationsFor('bypass'),
				softCheckpointIterationsFor('edits'),
			],
			['manual', 'manual', 'auto', 0, 25]);
	});

	test('старые настройки мигрируют по автопилоту, галочке правок и валидному новому полю', () => {
		assert.deepStrictEqual(
			[
				migratedPermissionMode({ chatAgentAutopilot: true }),
				migratedPermissionMode({}),
				migratedPermissionMode({ chatAgentAutopilot: false }),
				migratedPermissionMode({ chatAgentAutopilot: false, autoApprove: { edits: true } }),
				migratedPermissionMode({ chatAgentAutopilot: false, autoApprove: true }),
				migratedPermissionMode({ chatPermissionMode: 'bypass' }),
				migratedPermissionMode({ chatPermissionMode: 'garbage', chatAgentAutopilot: false }),
			],
			['auto', 'auto', 'manual', 'edits', 'manual', 'bypass', 'manual']);
	});

	test('настройки треда читают новое поле, старый autopilot и пустое значение', () => {
		assert.deepStrictEqual(
			[
				permissionModeOfThreadConfig({ permissionMode: 'bypass' }),
				permissionModeOfThreadConfig({ permissionMode: 'junk', autopilot: true }),
				permissionModeOfThreadConfig({ autopilot: false }),
				permissionModeOfThreadConfig({}),
				permissionModeOfThreadConfig({ permissionMode: 'auto', autopilot: false }),
			],
			['bypass', 'auto', 'manual', undefined, 'auto']);
	});

	test('факты вызова строятся по имени, типу одобрения и параметрам', () => {
		const file = URI.file('/work/proj/a.ts');
		assert.deepStrictEqual(
			[
				toolCallFactsOf('edit_file', 'edits', { uri: file }),
				toolCallFactsOf('delete_file_or_folder', 'edits', { uri: file }),
				toolCallFactsOf('run_command', 'terminal', { command: 'npm test' }),
				toolCallFactsOf('run_nl_command', 'terminal', {}),
				toolCallFactsOf('read_file', undefined, { uri: file }),
				toolCallFactsOf('grep', undefined, { searchInFolder: null }),
				toolCallFactsOf('some_mcp_tool', 'MCP tools', { uri: file }),
			],
			[
				{ kind: 'edit', paths: ['/work/proj/a.ts'] },
				{ kind: 'delete', paths: ['/work/proj/a.ts'] },
				{ kind: 'command', paths: [], command: 'npm test' },
				{ kind: 'command', paths: [] },
				{ kind: 'read', paths: ['/work/proj/a.ts'] },
				{ kind: 'read', paths: [] },
				{ kind: 'mcp', paths: [] },
			]);
	});
});
