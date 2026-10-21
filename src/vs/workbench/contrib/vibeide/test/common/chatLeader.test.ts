/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { chatLeaderKey, chatLeaderOf } from '../../common/chatLeader.js';
import { ModelSelection } from '../../common/vibeideSettingsTypes.js';

suite('chatLeader', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const model: ModelSelection = { providerName: 'openAI', modelName: 'gpt-5' };
	const agent = { agentId: 'claude', agentName: 'Claude Agent' };

	test('агент на треде ведёт его, какая бы модель ни стояла у функции «Чат»', () => {
		assert.deepStrictEqual(chatLeaderOf({ acpAgent: agent }, model), { kind: 'agent', agentId: 'claude', agentName: 'Claude Agent' });
	});

	test('без агента ведёт модель функции «Чат»; нет ни треда, ни выбора — модель не задана', () => {
		assert.deepStrictEqual(
			[chatLeaderOf({}, model), chatLeaderOf(undefined, model), chatLeaderOf({}, null), chatLeaderOf(undefined, undefined)],
			[{ kind: 'model', selection: model }, { kind: 'model', selection: model }, { kind: 'model', selection: null }, { kind: 'model', selection: null }]);
	});

	test('ключ меняется со сменой агента и не меняется со сменой модели', () => {
		const other: ModelSelection = { providerName: 'openAI', modelName: 'gpt-5-mini' };
		assert.deepStrictEqual(
			[chatLeaderOf({}, model), chatLeaderOf({}, other), chatLeaderOf({ acpAgent: agent }, model), chatLeaderOf({ acpAgent: { agentId: 'cursor', agentName: 'Cursor' } }, model)].map(chatLeaderKey),
			['model', 'model', 'agent:claude:Claude Agent', 'agent:cursor:Cursor']);
	});
});
