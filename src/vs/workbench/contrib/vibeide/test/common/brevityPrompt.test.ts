/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { brevityBlock, brevityForAgent, brevityLevelOf, brevityShortBlock } from '../../common/prompt/brevity.js';
import { chat_systemMessage, chat_systemMessage_local } from '../../common/prompt/prompts.js';

/** The shared file's shape in miniature: a licence comment, common sections, levels, the short form and the off notice */
const FIXTURE = [
	'<!--\nMIT notice\n-->',
	'## Reply style: terse\n\nStyle.',
	'## Rules\n\nRules.',
	'## Level: lite\n\nLite.',
	'## Level: full\n\nFull.',
	'## Level: ultra\n\nUltra.',
	'## Boundaries\n\nBoundaries.',
	'## Short\n\nShort.',
	'## Off\n\nOff.',
].join('\n');

/**
 * «Краткие ответы»: the text is the shared `terse/replies.md` of the set, read by sections — the levels and the default
 * are the contract with VibeIDEA, the licence comment never reaches the model
 */
suite('brevity — краткие ответы из общего файла набора', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('уровень из настройки; неизвестное — умолчание full, а не выключение', () => {
		assert.deepStrictEqual(['off', 'lite', 'full', 'ultra', 'loud', undefined].map(brevityLevelOf), ['off', 'lite', 'full', 'ultra', 'full', 'full']);
	});

	test('разделы: общие в порядке файла и только выбранный уровень; короткая форма; без комментария', () => {
		assert.deepStrictEqual({
			off: [brevityBlock('off', FIXTURE), brevityShortBlock('off', FIXTURE)],
			full: brevityBlock('full', FIXTURE),
			short: brevityShortBlock('ultra', FIXTURE),
			noShortSection: brevityShortBlock('lite', FIXTURE.replace('## Short\n\nShort.\n', '')),
			noLevelSection: brevityBlock('lite', FIXTURE.replace('## Level: lite\n\nLite.\n', '')),
		}, {
			off: [null, null],
			full: '## Reply style: terse\n\nStyle.\n\n## Rules\n\nRules.\n\n## Level: full\n\nFull.\n\n## Boundaries\n\nBoundaries.',
			short: '## Level: ultra\n\nUltra.\n\n## Short\n\nShort.',
			noShortSection: '## Reply style: terse\n\nStyle.\n\n## Rules\n\nRules.\n\n## Level: lite\n\nLite.\n\n## Boundaries\n\nBoundaries.',
			noLevelSection: null,
		});
	});

	test('внешнему агенту: один раз, снова при смене уровня; «выкл» — только тому, кому стиль уже ушёл', () => {
		const steps: [Parameters<typeof brevityForAgent>[0], Parameters<typeof brevityForAgent>[1]][] = [
			[undefined, 'full'], ['full', 'full'], ['full', 'lite'], ['lite', 'off'], ['off', 'off'], [undefined, 'off'],
		];
		assert.deepStrictEqual(steps.map(([sent, current]) => brevityForAgent(sent, current, FIXTURE)?.split('\n\n').find(line => line.startsWith('## Level') || line === '## Off')), [
			'## Level: full', undefined, '## Level: lite', '## Off', undefined, undefined,
		]);
	});

	test('отгружаемый файл: у каждого уровня и у короткой формы есть текст, комментарий с лицензией модели не уходит', () => {
		const levels = (['lite', 'full', 'ultra'] as const).map(level => [brevityBlock(level), brevityShortBlock(level)]);
		assert.deepStrictEqual(levels.map(([block, short]) => ({
			block: !!block && !block.includes('MIT License') && !block.includes('## Short') && !block.includes('## Off'),
			short: !!short && short.includes('## Short') && short.length < block!.length,
		})), [{ block: true, short: true }, { block: true, short: true }, { block: true, short: true }]);
	});

	test('в промпте любого режима, включая сбор; у локальной модели — короткой формой', () => {
		const params = (chatMode: 'agent' | 'gather', brevity: 'off' | 'full') => ({ workspaceFolders: ['/ws'], chatMode, mcpTools: undefined, includeXMLToolDefinitions: false, brevity });
		assert.deepStrictEqual([
			chat_systemMessage(params('agent', 'full')).includes(brevityBlock('full')!),
			chat_systemMessage(params('gather', 'full')).includes(brevityBlock('full')!),
			chat_systemMessage(params('agent', 'off')).includes('## Level:'),
			chat_systemMessage_local(params('agent', 'full')).includes(brevityShortBlock('full')!),
		], [true, true, false, true]);
	});
});
