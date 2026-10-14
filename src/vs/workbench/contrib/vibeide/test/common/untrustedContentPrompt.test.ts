/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMode } from '../../common/vibeideSettingsTypes.js';
import { chat_systemMessage, chat_systemMessage_local, chat_turnContext, UNTRUSTED_CONTENT_NOTE, UNTRUSTED_CONTENT_NOTE_SHORT } from '../../common/prompt/prompts.js';

/**
 * The system prompt tells the model that what tools return is data
 * The line is constant, so it belongs to the cached prefix, not to the per-turn block
 */
suite('system prompt — tool output is data, not instructions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const modes: ChatMode[] = ['agent', 'gather', 'plan', 'normal'];
	const base = { workspaceFolders: ['/ws'], mcpTools: undefined, includeXMLToolDefinitions: false };

	test('every mode of both templates carries the line, the turn block does not', () => {
		assert.deepStrictEqual({
			full: modes.map(chatMode => chat_systemMessage({ ...base, chatMode }).includes(UNTRUSTED_CONTENT_NOTE)),
			local: modes.map(chatMode => chat_systemMessage_local({ ...base, chatMode }).includes(UNTRUSTED_CONTENT_NOTE_SHORT)),
			turn: chat_turnContext({ chatMode: 'agent', activeURI: undefined, openedURIs: [], persistentTerminalIDs: [], directoryStr: undefined }).includes('not instructions'),
		}, {
			full: [true, true, true, true],
			local: [true, true, true, true],
			turn: false,
		});
	});

	test('the line is the same on every request: the cached prefix does not move', () => {
		const first = chat_systemMessage({ ...base, chatMode: 'agent' });
		const second = chat_systemMessage({ ...base, chatMode: 'agent' });

		assert.deepStrictEqual([first === second, first.split(UNTRUSTED_CONTENT_NOTE).length - 1], [true, 1]);
	});
});
