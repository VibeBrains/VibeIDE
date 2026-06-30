/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isPinnedContextMessage } from '../../common/prompt/pinnedContext.js';

const m = (role: string, content: unknown) => ({ role, content });

suite('isPinnedContextMessage — pin guidelines + skill bodies (3074 / 3075)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('system message with <workspace_guidelines> is pinned', () => {
		assert.strictEqual(isPinnedContextMessage(m('system', '<workspace_guidelines source="x">rules</workspace_guidelines>')), true);
	});

	test('user message with <skill_invocation> is pinned (the 3075 regression)', () => {
		// Skill bodies are prepended to the LAST USER message, not the system prompt.
		assert.strictEqual(isPinnedContextMessage(m('user', '<skill_invocation name="deploy">...body...</skill_invocation>\n\ndo the thing')), true);
	});

	test('system message with a skill block is also pinned', () => {
		assert.strictEqual(isPinnedContextMessage(m('system', 'prefix <skill_invocation name="x">b</skill_invocation>')), true);
	});

	test('plain system / user messages are NOT pinned', () => {
		assert.strictEqual(isPinnedContextMessage(m('system', 'You are a helpful assistant.')), false);
		assert.strictEqual(isPinnedContextMessage(m('user', 'fix the bug in foo.ts')), false);
	});

	test('the dead legacy marker no longer pins (real marker required)', () => {
		// "Explicitly invoked Agent Skills" is never emitted; it must NOT pin on its own.
		assert.strictEqual(isPinnedContextMessage(m('user', 'Explicitly invoked Agent Skills')), false);
	});

	test('assistant / tool messages are never pinned even if they echo the literal text', () => {
		assert.strictEqual(isPinnedContextMessage(m('assistant', '<skill_invocation name="x">b</skill_invocation>')), false);
		assert.strictEqual(isPinnedContextMessage(m('tool', 'file contents: <workspace_guidelines>')), false);
	});

	test('non-string content is not pinned', () => {
		assert.strictEqual(isPinnedContextMessage(m('user', [{ type: 'text', text: '<skill_invocation name="x">b</skill_invocation>' }])), false);
	});
});
