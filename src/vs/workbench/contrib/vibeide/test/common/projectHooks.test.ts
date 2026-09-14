/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { hooksFor, parseHookConfig, VIBE_HOOK_DEFAULT_TIMEOUT_MS, VIBE_HOOK_MAX_TIMEOUT_MS, VibeHook } from '../../common/hooks/hookConfig.js';
import { decideHooks, verdictOf, VIBE_HOOK_REFUSE_EXIT_CODE } from '../../common/hooks/hookOutcome.js';

const hook = (over: Partial<VibeHook> = {}): VibeHook => ({
	event: 'preToolUse', command: 'echo hi', tools: [], timeoutMs: 1000, label: undefined, ...over,
});

const run = (over: { exitCode?: number | undefined; stdout?: string; stderr?: string; timedOut?: boolean } = {}) => ({
	hook: hook(), exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 5, ...over,
});

suite('Project hooks — config', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('valid hooks are read, broken ones are dropped with a stated reason', () => {
		const parsed = parseHookConfig(JSON.stringify({
			hooks: [
				{ event: 'preToolUse', command: 'node guard.js', tools: ['run_command'] },
				{ event: 'turnEnd', command: 'npm test', tools: ['edit_file'] },
				{ event: 'whenever', command: 'echo' },
				{ event: 'postToolUse', command: '   ' },
				{ event: 'postToolUse', command: 'npm run lint', timeoutMs: VIBE_HOOK_MAX_TIMEOUT_MS * 10 },
			],
		}));
		assert.deepStrictEqual(
			{
				kept: parsed.hooks.map(h => [h.event, h.command, h.tools, h.timeoutMs]),
				problems: parsed.problems.length,
			},
			{
				kept: [
					['preToolUse', 'node guard.js', ['run_command'], VIBE_HOOK_DEFAULT_TIMEOUT_MS],
					// `tools` is meaningless for turnEnd — dropped, and the author is told.
					['turnEnd', 'npm test', [], VIBE_HOOK_DEFAULT_TIMEOUT_MS],
					['postToolUse', 'npm run lint', [], VIBE_HOOK_MAX_TIMEOUT_MS],
				],
				// Четыре: неизвестное событие, пустая команда, tools при turnEnd, урезанный таймаут.
				problems: 4,
			},
		);
	});

	test('a file that is not JSON is reported, not silently ignored', () => {
		const parsed = parseHookConfig('{ hooks: [ }');
		assert.deepStrictEqual({ hooks: parsed.hooks.length, hasProblem: parsed.problems.length === 1 }, { hooks: 0, hasProblem: true });
	});

	test('matching is by exact tool name; an empty list means every tool', () => {
		const config = parseHookConfig(JSON.stringify({
			hooks: [
				{ event: 'preToolUse', command: 'a', tools: ['run_command'] },
				{ event: 'preToolUse', command: 'b' },
				{ event: 'postToolUse', command: 'c', tools: ['edit_file'] },
				{ event: 'turnEnd', command: 'd' },
			],
		}));
		assert.deepStrictEqual(
			{
				runCommand: hooksFor(config, 'preToolUse', 'run_command').map(h => h.command),
				readFile: hooksFor(config, 'preToolUse', 'read_file').map(h => h.command),
				// A near-miss must not match: widening a narrow rule is how a guard stops guarding.
				prefix: hooksFor(config, 'preToolUse', 'run_command_background').map(h => h.command),
				post: hooksFor(config, 'postToolUse', 'edit_file').map(h => h.command),
				turn: hooksFor(config, 'turnEnd').map(h => h.command),
			},
			{ runCommand: ['a', 'b'], readFile: ['b'], prefix: ['b'], post: ['c'], turn: ['d'] },
		);
	});
});

suite('Project hooks — verdicts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('exit code decides, and only 2 means "refused"', () => {
		assert.deepStrictEqual(
			[
				verdictOf(run()).kind,
				verdictOf(run({ stdout: 'отформатировал два файла' })),
				verdictOf(run({ exitCode: VIBE_HOOK_REFUSE_EXIT_CODE, stderr: 'нельзя трогать migrations/' })),
				// 1 is what a broken script returns — a missing binary must not lock the project.
				verdictOf(run({ exitCode: 1, stderr: 'command not found' })).kind,
				verdictOf(run({ exitCode: undefined, timedOut: true })).kind,
				verdictOf(run({ exitCode: undefined, stderr: 'spawn ENOENT' })).kind,
			],
			[
				'ok',
				{ kind: 'note', text: 'отформатировал два файла' },
				{ kind: 'refuse', text: 'нельзя трогать migrations/' },
				'broken',
				'broken',
				'broken',
			],
		);
	});

	// Хук, перенесённый из Claude Code, отказывает джейсоном, а код выхода оставляет нулевым.
	// Та же таблица случаев живёт в VibeIDEA (HookOutcomeTest.kt): контракт один — поведение одно.
	test('a hook written for Claude Code refuses with JSON while the exit code stays 0', () => {
		const said = (stdout: string) => verdictOf(run({ stdout }));
		assert.deepStrictEqual(
			[
				said('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Destructive command"}}'),
				said('{"decision":"block","reason":"нельзя"}'),
				said('{"continue": false, "stopReason": "хватит"}'),
				said('{"decision":"approve"}').kind,
				said('{"hookSpecificOutput":{"permissionDecision":"allow"}}').kind,
				said('{"hookSpecificOutput":{"permissionDecision":"ask"}}').kind,
				// Решением считается только вывод, который начинается с { и заканчивается }.
				said('{"lines": 350}').kind,
				said('{"decision": }').kind,
				said('хук говорит {"decision":"block"}').kind,
				// Их же правило: allow из JSON не отменяет код 2.
				verdictOf(run({ exitCode: VIBE_HOOK_REFUSE_EXIT_CODE, stdout: '{"decision":"approve"}', stderr: 'стоп' })),
			],
			[
				{ kind: 'refuse', text: 'Destructive command' },
				{ kind: 'refuse', text: 'нельзя' },
				{ kind: 'refuse', text: 'хватит' },
				'ok',
				'ok',
				'broken',
				'note',
				'note',
				'note',
				{ kind: 'refuse', text: 'стоп' },
			],
		);
	});

	test('their refusal blocks preToolUse, and «ask» is told to the user instead', () => {
		const deny = verdictOf(run({ stdout: '{"decision":"deny","reason":"нельзя"}' }));
		const ask = verdictOf(run({ stdout: '{"hookSpecificOutput":{"permissionDecision":"ask"}}' }));
		assert.deepStrictEqual(
			{
				denyBlocks: decideHooks('preToolUse', [deny]).blocked,
				askBlocks: decideHooks('preToolUse', [ask]).blocked,
				askIsTold: decideHooks('preToolUse', [ask]).brokenHooks.length,
			},
			{ denyBlocks: true, askBlocks: false, askIsTold: 1 },
		);
	});

	test('a refusal outranks notes, and only preToolUse can block', () => {
		const verdicts = [
			{ kind: 'note' as const, text: 'заметка' },
			{ kind: 'refuse' as const, text: 'нельзя' },
			{ kind: 'broken' as const, text: 'хук сломан' },
		];
		const pre = decideHooks('preToolUse', verdicts);
		const post = decideHooks('postToolUse', verdicts);
		assert.deepStrictEqual(
			{
				preBlocked: pre.blocked,
				preSaysNoFirst: pre.agentMessage?.includes('нельзя') === true && pre.agentMessage?.includes('заметка') === false,
				// After the fact there is nothing to block: the agent is told to fix it instead.
				postBlocked: post.blocked,
				broken: pre.brokenHooks,
				quiet: decideHooks('turnEnd', [{ kind: 'ok' }]).agentMessage,
			},
			{ preBlocked: true, preSaysNoFirst: true, postBlocked: false, broken: ['хук сломан'], quiet: undefined },
		);
	});

	/**
	 * Два предусловия общего набора сидов: файл засевается с комментариями и с выключенными
	 * записями. Строгий парсер сломался бы на первой строке, а невыключённый хук запустил бы
	 * чужую команду сразу после засева.
	 */
	test('комментарии не ломают файл, а active:false не выполняется', () => {
		const raw = `{
			// Проверки проекта. Снимите active, чтобы включить.
			"hooks": [
				{ "event": "preToolUse", "command": "echo выключен", "active": false },
				{ "event": "preToolUse", "command": "echo включен" }, // висячая запятая ниже тоже допустима
			]
		}`;
		const config = parseHookConfig(raw);
		assert.deepStrictEqual({
			команды: config.hooks.map(h => h.command),
			проблемы: config.problems,
		}, { команды: ['echo включен'], проблемы: [] });
	});

	/** Отсутствие поля — не повод выключать: файл, написанный человеком, пишется чтобы работать. */
	test('active по умолчанию включён, и только явный false выключает', () => {
		const commandsOf = (active: string) =>
			parseHookConfig(`{"hooks":[{"event":"turnEnd","command":"c"${active}}]}`).hooks.length;
		assert.deepStrictEqual({
			безПоля: commandsOf(''),
			явныйTrue: commandsOf(', "active": true'),
			явныйFalse: commandsOf(', "active": false'),
		}, { безПоля: 1, явныйTrue: 1, явныйFalse: 0 });
	});

	suite('pipelineStepEnd — гейт приёмки каскада', () => {
		/** Контракт общего набора сидов: событие есть, и «tools» к нему не применяется. */
		test('событие принимается, а tools игнорируется как у turnEnd', () => {
			const config = parseHookConfig(`{"hooks":[
				{"event":"pipelineStepEnd","command":"node gate.js","tools":["read_file"]}
			]}`);
			assert.deepStrictEqual({
				событий: config.hooks.length,
				инструменты: config.hooks[0]?.tools,
				проблемы: config.problems,
			}, {
				событий: 1,
				инструменты: [],
				проблемы: ['Хук №1: «tools» не применяется к событию pipelineStepEnd — список проигнорирован.'],
			});
		});

		/** Хук события выбирается независимо от имени инструмента — вызова тут нет вовсе. */
		test('выбирается без привязки к инструменту', () => {
			const config = parseHookConfig(`{"hooks":[{"event":"pipelineStepEnd","command":"node gate.js"}]}`);
			assert.deepStrictEqual({
				безИнструмента: hooksFor(config, 'pipelineStepEnd').map(h => h.command),
				сЧужимИменем: hooksFor(config, 'pipelineStepEnd', 'read_file').map(h => h.command),
				чужоеСобытие: hooksFor(config, 'turnEnd').map(h => h.command),
			}, { безИнструмента: ['node gate.js'], сЧужимИменем: ['node gate.js'], чужоеСобытие: [] });
		});
	});
});
