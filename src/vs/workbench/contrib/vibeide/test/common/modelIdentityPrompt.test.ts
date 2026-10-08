/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { chat_systemMessage, chat_systemMessage_local, modelIdentityLine } from '../../common/prompt/prompts.js';

/**
 * A model asked who it is answers from training unless the system prompt names it
 * Models trained on many Claude answers called themselves Claude
 */
suite('model identity in the system prompt', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const identity = { name: 'MiniMax M3.1 Flash Preview', id: 'MiniMax-M3.1-Flash-Preview', provider: 'MiniMax' };
	const base = { workspaceFolders: ['/ws'], chatMode: 'agent' as const, mcpTools: undefined, includeXMLToolDefinitions: false };

	test('both templates name the model when it is known and stay silent otherwise', () => {
		const line = modelIdentityLine(identity);
		assert.deepStrictEqual({
			line,
			sameNameAndId: modelIdentityLine({ name: 'gpt-5', id: 'gpt-5', provider: 'OpenAI' }),
			full: chat_systemMessage({ ...base, modelIdentity: identity }).includes(line),
			local: chat_systemMessage_local({ ...base, modelIdentity: identity }).includes(line),
			withoutIdentity: chat_systemMessage(base).includes('You are the model'),
		}, {
			line: 'You are the model MiniMax M3.1 Flash Preview (MiniMax-M3.1-Flash-Preview), served by MiniMax. If asked who you are, name this model, not what your training suggests.',
			sameNameAndId: 'You are the model gpt-5, served by OpenAI. If asked who you are, name this model, not what your training suggests.',
			full: true,
			local: true,
			withoutIdentity: false,
		});
	});
});
