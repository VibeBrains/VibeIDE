/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITurnContinuationInput, decideTurnContinuation } from '../../common/turnContinuation.js';

suite('продолжение хода', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const inputOf = (overrides: Partial<ITurnContinuationInput> = {}): ITurnContinuationInput => ({
		askedQuestion: false,
		emptyTurn: false,
		autonomousMode: true,
		humanless: false,
		textNudgesUsed: 0,
		maxTextNudges: 3,
		questionNudgesUsed: 0,
		maxQuestionNudges: 2,
		...overrides,
	});

	test('вопрос модели при человеке всегда останавливает ход, даже в auto', () => {
		assert.deepStrictEqual(
			[decideTurnContinuation(inputOf({ askedQuestion: true })), decideTurnContinuation(inputOf({ askedQuestion: true, autonomousMode: false }))],
			['stop', 'stop']);
	});

	test('без человека вопрос подпинывается до лимита, после лимита — остановка', () => {
		assert.deepStrictEqual(
			[
				decideTurnContinuation(inputOf({ askedQuestion: true, humanless: true, questionNudgesUsed: 0 })),
				decideTurnContinuation(inputOf({ askedQuestion: true, humanless: true, questionNudgesUsed: 1 })),
				decideTurnContinuation(inputOf({ askedQuestion: true, humanless: true, questionNudgesUsed: 2 })),
			],
			['questionNudge', 'questionNudge', 'stop']);
	});

	test('нулевой лимит вопросов означает отсутствие лимита', () => {
		assert.deepStrictEqual(
			[decideTurnContinuation(inputOf({ askedQuestion: true, humanless: true, questionNudgesUsed: 50, maxQuestionNudges: 0 }))],
			['questionNudge']);
	});

	test('пустой ход в ручном режиме останавливается, в автономном подпинывается', () => {
		assert.deepStrictEqual(
			[
				decideTurnContinuation(inputOf({ emptyTurn: true, autonomousMode: false })),
				decideTurnContinuation(inputOf({ emptyTurn: true, autonomousMode: true })),
			],
			['stop', 'emptyTurnNudge']);
	});

	test('текстовый ход в автономном режиме подпинывается до лимита и останавливается на нём', () => {
		assert.deepStrictEqual(
			[
				decideTurnContinuation(inputOf({ textNudgesUsed: 2 })),
				decideTurnContinuation(inputOf({ textNudgesUsed: 3 })),
			],
			['textTurnNudge', 'stop']);
	});

	test('выключенные подпины текста останавливают любой автономный ход', () => {
		assert.deepStrictEqual(
			[decideTurnContinuation(inputOf({ maxTextNudges: 0, emptyTurn: true })), decideTurnContinuation(inputOf({ maxTextNudges: 0 }))],
			['stop', 'stop']);
	});
});
