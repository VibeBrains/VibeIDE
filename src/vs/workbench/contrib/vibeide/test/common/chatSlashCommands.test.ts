/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	CHAT_SLASH_COMMANDS,
	parseChatSlashCommand,
} from '../../common/chatSlashCommands.js';

suite('chatSlashCommands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseChatSlashCommand', () => {

		test('bare /commit matches', () => {
			const out = parseChatSlashCommand('/commit');
			assert.ok(out.matched);
			assert.strictEqual(out.parsed.command, 'commit');
			assert.deepStrictEqual([...out.parsed.flags], []);
			assert.strictEqual(out.parsed.args, '');
		});

		test('/commit with --push flag', () => {
			const out = parseChatSlashCommand('/commit --push');
			assert.ok(out.matched);
			assert.deepStrictEqual([...out.parsed.flags], ['push']);
			assert.strictEqual(out.parsed.args, '');
		});

		test('/commit with flag + args', () => {
			const out = parseChatSlashCommand('/commit --push focus on auth');
			assert.ok(out.matched);
			assert.deepStrictEqual([...out.parsed.flags], ['push']);
			assert.strictEqual(out.parsed.args, 'focus on auth');
		});

		test('multiple flags', () => {
			const out = parseChatSlashCommand('/commit --push --amend stuff');
			assert.ok(out.matched);
			assert.deepStrictEqual([...out.parsed.flags], ['push', 'amend']);
			assert.strictEqual(out.parsed.args, 'stuff');
		});

		test('flags stop at first non-flag token', () => {
			// `--push` is a flag; `auth` is the start of args; subsequent `--push`
			// is part of the message body, not a flag.
			const out = parseChatSlashCommand('/commit --push auth and --push area');
			assert.ok(out.matched);
			assert.deepStrictEqual([...out.parsed.flags], ['push']);
			assert.strictEqual(out.parsed.args, 'auth and --push area');
		});

		test('leading whitespace is tolerated', () => {
			const out = parseChatSlashCommand('   /commit  some hint  ');
			assert.ok(out.matched);
			assert.strictEqual(out.parsed.args, 'some hint');
		});

		test('case-insensitive command name', () => {
			const out = parseChatSlashCommand('/COMMIT');
			assert.ok(out.matched);
			assert.strictEqual(out.parsed.command, 'commit');
		});

		test('unknown command → no match', () => {
			const out = parseChatSlashCommand('/unknown');
			assert.strictEqual(out.matched, false);
		});

		test('not a slash command → no match', () => {
			assert.strictEqual(parseChatSlashCommand('write a commit message').matched, false);
			assert.strictEqual(parseChatSlashCommand('').matched, false);
			assert.strictEqual(parseChatSlashCommand('/').matched, false);
		});

		test('non-string input → no match', () => {
			// @ts-expect-error — runtime defense
			assert.strictEqual(parseChatSlashCommand(123).matched, false);
		});
	});

	suite('CHAT_SLASH_COMMANDS catalog', () => {

		test('contains commit entry', () => {
			const commit = CHAT_SLASH_COMMANDS.find(c => c.name === 'commit');
			assert.ok(commit);
			assert.ok(commit.description.length > 0);
		});
	});
});
