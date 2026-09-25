/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { brevityBlock, brevityLevelOf, brevityLine } from '../../common/prompt/brevity.js';
import { chat_systemMessage, chat_systemMessage_local } from '../../common/prompt/prompts.js';

/**
 * «Краткие ответы»: on from the start at `full`, a typo falls back to it, and the rules ride the stable system prompt —
 * in every mode, the read-only one included, and as one line for local models
 */
suite('brevity — краткие ответы в системном промпте', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('уровень из настройки; неизвестное — умолчание full, а не выключение', () => {
		assert.deepStrictEqual(['off', 'lite', 'full', 'ultra', 'loud', undefined].map(brevityLevelOf), ['off', 'lite', 'full', 'ultra', 'full', 'full']);
	});

	test('блок по уровню: выключено — ничего, у каждого уровня своё правило, границы полной речи на месте', () => {
		assert.deepStrictEqual([brevityBlock('off'), brevityLine('off')], [null, null]);
		const block = (level: 'lite' | 'full' | 'ultra') => brevityBlock(level)!;
		assert.deepStrictEqual({
			lite: block('lite').includes('Level lite'),
			full: block('full').includes('Level full'),
			ultra: block('ultra').includes('Level ultra'),
			negations: block('full').includes('Never drop'),
			outsideChat: block('full').includes('commit messages, documentation'),
			irreversible: block('full').includes('irreversible'),
		}, { lite: true, full: true, ultra: true, negations: true, outsideChat: true, irreversible: true });
	});

	test('в промпте любого режима, включая сбор; у локальной модели — одной строкой', () => {
		const params = (chatMode: 'agent' | 'gather', brevity: 'off' | 'full') => ({ workspaceFolders: ['/ws'], chatMode, mcpTools: undefined, includeXMLToolDefinitions: false, brevity });
		assert.deepStrictEqual([
			chat_systemMessage(params('agent', 'full')).includes('<brevity level="full">'),
			chat_systemMessage(params('gather', 'full')).includes('<brevity level="full">'),
			chat_systemMessage(params('agent', 'off')).includes('<brevity'),
			chat_systemMessage_local(params('agent', 'full')).includes('Brevity (full)'),
		], [true, true, false, true]);
	});
});
