/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMessage } from '../../common/chatThreadServiceTypes.js';
import { chat_systemMessage, chat_systemMessage_local, chat_turnContext } from '../../common/prompt/prompts.js';
import { FILES_OVERVIEW_UNCHANGED, lastRealUserIndex, withoutRepeatedFilesOverview } from '../../common/turnContext.js';

/**
 * The system prompt is the conversation's cached prefix; what changes from turn to turn rides with the user's message
 * An active file or a date in the system prompt rebuilt the prefix on every tab switch, and the cache went with it
 */
suite('turn context — the stable prefix', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const user = (content: string, extra: Partial<ChatMessage & { role: 'user' }> = {}): ChatMessage => ({ role: 'user', content, displayContent: content, selections: null, state: { stagingSelections: [], isBeingEdited: false }, ...extra });

	test('the system prompt carries no editor state and no date; the turn block carries them', () => {
		const system = chat_systemMessage({ workspaceFolders: ['/ws'], chatMode: 'agent', mcpTools: undefined, includeXMLToolDefinitions: false });
		const local = chat_systemMessage_local({ workspaceFolders: ['/ws'], chatMode: 'agent', mcpTools: undefined, includeXMLToolDefinitions: false });
		const turn = chat_turnContext({ chatMode: 'agent', activeURI: '/ws/a.ts', openedURIs: ['/ws/a.ts', '/ws/b.ts'], persistentTerminalIDs: ['1'], directoryStr: 'ws/\n  a.ts', relevantMemories: '- [Decision] x: y', activatedRules: '[Source: src/AGENTS.md]\nЛИМОН' });
		const localTurn = chat_turnContext({ chatMode: 'agent', activeURI: '/ws/a.ts', openedURIs: [], persistentTerminalIDs: [], directoryStr: undefined, local: true });
		assert.deepStrictEqual({
			systemHasDate: /Today:|Date:/.test(system) || /Today:|Date:/.test(local),
			systemHasOpenFiles: system.includes('Open files') || local.includes('Active:'),
			turn: ['- Date:', '- Active file: /ws/a.ts', '/ws/b.ts', 'Persistent terminal IDs', '<project_memories>', '<activated_rules>', 'ЛИМОН', '<files_overview>'].map(part => turn.includes(part)),
			localTurn: [localTurn.includes('- Date:'), localTurn.includes('<files_overview>'), localTurn.includes('- Active file: /ws/a.ts')],
		}, {
			systemHasDate: false,
			systemHasOpenFiles: false,
			turn: [true, true, true, true, true, true, true, true],
			localTurn: [false, false, true],
		});
	});

	test('the context goes to the last message a person wrote, not to a nudge', () => {
		assert.deepStrictEqual(
			[lastRealUserIndex([user('a'), user('nudge', { isSyntheticNudge: true })]), lastRealUserIndex([]), lastRealUserIndex([user('a'), user('b')])],
			[0, -1, 1],
		);
	});

	test('the file tree goes again only when it changed since the last message that carries one', () => {
		const tree = (body: string) => `<turn_context>\n- Active file: x\n\n<files_overview>\n${body}\n</files_overview>\n</turn_context>`;
		const same = withoutRepeatedFilesOverview(tree('a.ts'), [tree('a.ts'), undefined]);
		const afterUnchanged = withoutRepeatedFilesOverview(tree('a.ts'), [tree('a.ts'), tree('a.ts').replace(/<files_overview>[\s\S]*<\/files_overview>/, FILES_OVERVIEW_UNCHANGED)]);
		const changed = withoutRepeatedFilesOverview(tree('a.ts\nb.ts'), [tree('a.ts')]);
		const first = withoutRepeatedFilesOverview(tree('a.ts'), []);
		assert.deepStrictEqual(
			[same.includes(FILES_OVERVIEW_UNCHANGED), afterUnchanged.includes(FILES_OVERVIEW_UNCHANGED), changed.includes('b.ts'), first.includes('a.ts')],
			[true, true, true, true],
		);
	});
});
