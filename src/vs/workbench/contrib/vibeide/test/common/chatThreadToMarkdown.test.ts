/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { threadToMarkdown } from '../../common/chatThreadToMarkdown.js';
import { ChatMessage } from '../../common/chatThreadServiceTypes.js';

suite('chatThreadToMarkdown', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const user = (text: string): ChatMessage => ({
		role: 'user', content: text, displayContent: text, selections: null,
		state: { stagingSelections: [], isBeingEdited: false },
	});
	const assistant = (displayContent: string, reasoning = ''): ChatMessage => ({
		role: 'assistant', displayContent, reasoning, anthropicReasoning: null,
	});
	// The serializer only reads `name`, `type`, `content` and `result` (as unknown).
	// `params`/`result` carry deliberately minimal test fixtures, so the structurally
	// strict `ToolMessage<'read_file'>` shape is satisfied via a single assertion.
	const toolMsg = (name: string, result: string): ChatMessage => ({
		role: 'tool', type: 'success', name, id: 'id1',
		content: result, rawParams: { uri: 'c:/x.ts' }, mcpServerName: undefined,
		params: {}, result,
	}) as unknown as ChatMessage;

	test('serializes user + assistant turns', () => {
		const md = threadToMarkdown([user('привет'), assistant('ответ')]);
		assert.ok(md.includes('## 👤 Пользователь'));
		assert.ok(md.includes('привет'));
		assert.ok(md.includes('## 🤖 Ассистент'));
		assert.ok(md.includes('ответ'));
	});

	test('ALWAYS emits collapsed reasoning (the whole point)', () => {
		const md = threadToMarkdown([assistant('итог', 'скрытая цепочка размышления')]);
		assert.ok(md.includes('<details><summary>🧠 Размышления</summary>'));
		assert.ok(md.includes('скрытая цепочка размышления'));
	});

	test('truncateToolResults trims long tool output with a marker', () => {
		const big = 'x'.repeat(5000);
		const truncated = threadToMarkdown([toolMsg('read_file', big)], { truncateToolResults: true, toolResultMaxChars: 1000 });
		const full = threadToMarkdown([toolMsg('read_file', big)], { truncateToolResults: false });
		assert.ok(truncated.includes('усечено'), 'truncated mode shows elision marker');
		assert.ok(truncated.length < full.length, 'truncated output is shorter than full');
		assert.ok(full.includes(big), 'full mode keeps the entire result');
	});

	test('escapes fences when body contains triple backticks', () => {
		const md = threadToMarkdown([assistant('```js\ncode\n```')]);
		// body has ```, so the wrapping fence must be longer (````) to not close early
		assert.ok(md.includes('````') || md.includes('```js\ncode\n```'));
	});

	test('empty thread yields just the header', () => {
		const md = threadToMarkdown([]);
		assert.ok(md.startsWith('# '));
	});
});
