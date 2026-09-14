/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	CHAT_SLASH_COMMANDS,
	PROMPT_SLASH_COMMAND_NAMES,
	findChatCommandSpans,
	isSlashCommandFileName,
	parseChatSlashCommand,
	parsePromptSlashInvocation,
	splitWatchArgs,
} from '../../common/chatSlashCommands.js';

suite('chatSlashCommands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseChatSlashCommand — the commands the IDE runs itself', () => {

		test('/watch and /shot match with their args; leading whitespace and case are tolerated', () => {
			assert.deepStrictEqual(
				['/shot', '   /watch  https://youtu.be/abc  ', '/WATCH x'].map(text => parseChatSlashCommand(text)),
				[
					{ matched: true, parsed: { command: 'shot', args: '' } },
					{ matched: true, parsed: { command: 'watch', args: 'https://youtu.be/abc' } },
					{ matched: true, parsed: { command: 'watch', args: 'x' } },
				],
			);
		});

		test('prompt commands are not the IDE\'s to run — /commit included, it has no handler here', () => {
			const texts = ['/commit', '/commit --push', '/simplify', '/my:review', '/unknown', 'write a commit message', '', '/'];
			assert.deepStrictEqual(texts.map(text => parseChatSlashCommand(text).matched), texts.map(() => false));
		});

		test('non-string input → no match', () => {
			// @ts-expect-error — runtime defense
			assert.strictEqual(parseChatSlashCommand(123).matched, false);
		});
	});

	suite('watch command', () => {

		test('/watch with url and hint parses and splits', () => {
			const out = parseChatSlashCommand('/watch https://youtu.be/abc123 что показано на демо?');
			assert.ok(out.matched);
			assert.strictEqual(out.parsed.command, 'watch');
			assert.deepStrictEqual(
				splitWatchArgs(out.parsed.args),
				{ target: 'https://youtu.be/abc123', hint: 'что показано на демо?' },
			);
		});

		test('splitWatchArgs edge cases', () => {
			assert.deepStrictEqual(splitWatchArgs('https://youtu.be/abc'), { target: 'https://youtu.be/abc', hint: '' });
			assert.deepStrictEqual(splitWatchArgs('  '), { target: '', hint: '' });
			// Quoted local path with spaces + question after it.
			assert.deepStrictEqual(
				splitWatchArgs('"D:\\мои видео\\созвон.mp4" где обсуждали дедлайн'),
				{ target: 'D:\\мои видео\\созвон.mp4', hint: 'где обсуждали дедлайн' },
			);
		});
	});

	suite('parsePromptSlashInvocation — the commands that are prompts', () => {

		test('every built-in name is recognised at the start of the message, with its args', () => {
			assert.deepStrictEqual(
				PROMPT_SLASH_COMMAND_NAMES.map(name => parsePromptSlashInvocation(`/${name} src/app.ts`)),
				PROMPT_SLASH_COMMAND_NAMES.map(name => ({ command: name, args: 'src/app.ts' })),
			);
		});

		test('args keep their lines; leading whitespace and the case of a built-in are tolerated', () => {
			assert.deepStrictEqual(
				['  /Simplify\nтолько auth\nи тесты  ', '/commit --push про авторизацию'].map(text => parsePromptSlashInvocation(text)),
				[
					{ command: 'simplify', args: 'только auth\nи тесты' },
					{ command: 'commit', args: '--push про авторизацию' },
				],
			);
		});

		test('/my: and /workflow: take a file name — any alphabet, kept as typed; the namespace is case-insensitive', () => {
			assert.deepStrictEqual(
				['/my:Ревью-API.v2 в модуле auth', '/WORKFLOW:release'].map(text => parsePromptSlashInvocation(text)),
				[
					{ command: 'my:Ревью-API.v2', args: 'в модуле auth' },
					{ command: 'workflow:release', args: '' },
				],
			);
		});

		test('not a prompt command: mid-sentence, unknown, a skill, the IDE\'s own, an empty or broken name', () => {
			const texts = ['look at /docs please', '/unknown', '/simplifyx', '/skill:review', '/watch https://x', '/shot', '/my:', '/workflow: x', '/my:bad!name', '', '/'];
			assert.deepStrictEqual(texts.map(text => parsePromptSlashInvocation(text)), texts.map(() => undefined));
		});

		test('non-string input → undefined', () => {
			// @ts-expect-error — runtime defense
			assert.strictEqual(parsePromptSlashInvocation(123), undefined);
		});
	});

	suite('findChatCommandSpans — what the chat highlights', () => {

		const marked = (text: string) => findChatCommandSpans(text).map(({ start, end }) => text.slice(start, end));

		test('a skill wherever it starts a word; any command only at the very start of the message', () => {
			assert.deepStrictEqual(marked('/simplify и /skill:review, путь /docs и /watch'), ['/simplify', '/skill:review']);
		});

		test('leading whitespace, file names of any alphabet, the IDE\'s own commands; nothing inside a word or a path', () => {
			assert.deepStrictEqual(
				['  /my:ревью x', '/workflow:release', '/watch https://x', 'путь /usr/bin', 'a/skill:x'].map(marked),
				[['/my:ревью'], ['/workflow:release'], ['/watch'], [], []],
			);
		});
	});

	suite('isSlashCommandFileName', () => {

		test('letters of any alphabet, digits, "_", ".", "-" — nothing that would end the command', () => {
			const names = ['example', 'CLAUDE-FABLE-5', 'ревью_v2.1', 'с пробелом', 'a/b', 'a:b', ''];
			assert.deepStrictEqual(names.map(name => isSlashCommandFileName(name)), [true, true, true, false, false, false, false]);
		});
	});

	suite('catalogs', () => {

		test('the IDE runs /shot and /watch itself; the rest are prompts, and no name is in both lists', () => {
			const ide: readonly string[] = CHAT_SLASH_COMMANDS.map(c => c.name);
			assert.deepStrictEqual({
				ide: [...ide].sort(),
				described: CHAT_SLASH_COMMANDS.every(c => c.description.length > 0),
				overlap: PROMPT_SLASH_COMMAND_NAMES.filter(name => ide.includes(name)),
			}, { ide: ['shot', 'watch'], described: true, overlap: [] });
		});
	});
});
