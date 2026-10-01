/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatRunObservation, deriveRunStatus, pickFinalAnswer, ThreadRunTracker } from '../../common/chatRunOutcome.js';
import { ChatMessage } from '../../common/chatThreadServiceTypes.js';

function observe(over: Partial<ChatRunObservation>): ChatRunObservation {
	return { inFlight: false, aborted: false, isRunning: undefined, hasError: false, paused: false, ...over };
}

function assistant(displayContent: string, createdAt: number | undefined, notice?: boolean): ChatMessage {
	return {
		role: 'assistant', displayContent, reasoning: '', anthropicReasoning: null,
		...(createdAt !== undefined ? { createdAt } : {}),
		...(notice ? { notice: true } : {}),
	};
}

function user(displayContent: string, createdAt: number): ChatMessage {
	return { role: 'user', content: displayContent, displayContent, selections: null, state: { stagingSelections: [], isBeingEdited: false }, createdAt };
}

suite('chatRunOutcome — run status', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every combination an outside caller can meet maps to one phase', () => {
		assert.deepStrictEqual(
			[
				// In flight: never terminal, whatever the state says
				observe({ inFlight: true, isRunning: 'LLM' }),
				observe({ inFlight: true, isRunning: undefined }),
				observe({ inFlight: true, hasError: true }),
				observe({ inFlight: true, aborted: true }),
				observe({ inFlight: true, isRunning: 'awaiting_user' }),
				// Settled
				observe({ isRunning: undefined }),
				observe({ isRunning: 'idle' }),
				observe({ hasError: true }),
				observe({ aborted: true }),
				observe({ aborted: true, hasError: true }),
				observe({ paused: true }),
				observe({ paused: true, hasError: true }),
				observe({ isRunning: 'awaiting_user' }),
				observe({ isRunning: 'LLM' }),
				observe({ isRunning: 'tool' }),
				observe({ isRunning: 'preparing' }),
			].map(deriveRunStatus),
			[
				'running', 'running', 'running', 'running', 'awaiting_approval',
				'completed', 'completed', 'failed', 'aborted', 'aborted', 'running', 'failed',
				'awaiting_approval', 'running', 'running', 'running',
			],
		);
	});
});

suite('chatRunOutcome — final answer', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the newest model answer of this run wins over notices, empty turns and earlier runs', () => {
		const messages: ChatMessage[] = [
			assistant('ответ прошлого прогона', 50),
			user('задача', 100),
			assistant('промежуточный текст', 110),
			assistant('итоговый ответ', 120),
			assistant('   ', 125),
			assistant('⚠️ ПРОВЕРКИ ХОДА: кое-что стоит посмотреть', 130, true),
		];
		assert.deepStrictEqual(pickFinalAnswer(messages, 100, Number.POSITIVE_INFINITY), { text: 'итоговый ответ', truncated: false });
	});

	test('nothing written since the start means no answer, and an unstamped message is never taken', () => {
		const messages: ChatMessage[] = [
			assistant('ответ прошлого прогона', 50),
			assistant('без отметки времени', undefined),
			user('задача', 100),
			assistant('Прогон завершён: модель закончила ход текстом', 110, true),
		];
		assert.deepStrictEqual(pickFinalAnswer(messages, 100, Number.POSITIVE_INFINITY), undefined);
	});

	test('a long answer is cut to the limit without splitting a character', () => {
		const emoji = '😀';
		assert.deepStrictEqual(
			[
				pickFinalAnswer([assistant('абвгд', 1)], 0, 3),
				pickFinalAnswer([assistant('абв', 1)], 0, 3),
				pickFinalAnswer([assistant(`ab${emoji}cd`, 1)], 0, 3),
			],
			[
				{ text: 'абв', truncated: true },
				{ text: 'абв', truncated: false },
				{ text: 'ab', truncated: true },
			],
		);
	});
});

suite('chatRunOutcome — runs in flight', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('settles only after every piece, including one started while waiting', async () => {
		const tracker = new ThreadRunTracker();
		const order: string[] = [];
		let finishFirst!: () => void;
		let finishRestart!: () => void;
		tracker.track('t', new Promise<void>(resolve => { finishFirst = resolve; }));
		const settled = tracker.whenSettled('t').then(() => { order.push('settled'); });

		// A re-send scheduled from inside the first run, before the first one returns
		tracker.track('t', new Promise<void>(resolve => { finishRestart = resolve; }));
		finishFirst();
		await Promise.resolve();
		order.push(`first done, in flight: ${tracker.isInFlight('t')}`);
		finishRestart();
		await settled;
		assert.deepStrictEqual([...order, `in flight: ${tracker.isInFlight('t')}`], [
			'first done, in flight: true',
			'settled',
			'in flight: false',
		]);
	});

	test('a failed run settles the thread too, and an idle thread settles at once', async () => {
		const tracker = new ThreadRunTracker();
		const failed = Promise.reject(new Error('сбой'));
		failed.catch(() => { /* owned by the test */ });
		tracker.track('t', failed);
		await tracker.whenSettled('t');
		await tracker.whenSettled('other');
		assert.deepStrictEqual([tracker.isInFlight('t'), tracker.isInFlight('other')], [false, false]);
	});
});
