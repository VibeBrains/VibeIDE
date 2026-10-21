/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AttentionKind,
	AttentionLedger,
	ATTENTION_DETAIL_LIMIT,
	ATTENTION_THREAD_LABEL_LIMIT,
	attentionClassKey,
	classifyStreamAttention,
	formatAttentionMessage,
	isCoveredByTelegramRun,
	isTurnRunning,
	selectAttentionRecipients,
	threadLabelOf,
} from '../../common/telegram/telegramAttention.js';

suite('Telegram bridge — пуш «агенту нужно внимание»', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('состояние ленты: ошибка, зависание, разрешение; остальное внимания не просит', () => {
		assert.deepStrictEqual(
			[
				classifyStreamAttention(undefined),
				classifyStreamAttention({ isRunning: 'LLM' }),
				classifyStreamAttention({ isRunning: 'tool' }),
				classifyStreamAttention({ isRunning: 'idle' }),
				classifyStreamAttention({ isRunning: undefined }),
				classifyStreamAttention({ isRunning: 'awaiting_user' }),
				classifyStreamAttention({ isRunning: undefined, error: { message: 'HTTP 500' } }),
				classifyStreamAttention({ isRunning: undefined, error: { message: 'Стрим завис', recoverable: 'retry' } }),
				classifyStreamAttention({ isRunning: undefined, error: { message: 'Лимит', recoverable: 'switchModel' } }),
			],
			[
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ kind: 'awaitingApproval' },
				{ kind: 'turnFailed', detail: 'HTTP 500' },
				{ kind: 'stalled', detail: 'Стрим завис' },
				{ kind: 'turnFailed', detail: 'Лимит' },
			],
		);
	});

	test('ход идёт только в состояниях LLM, tool и preparing', () => {
		assert.deepStrictEqual(
			[undefined, 'LLM', 'tool', 'preparing', 'idle', 'awaiting_user'].map(isRunning => isTurnRunning(isRunning === undefined ? undefined : { isRunning })),
			[false, true, true, true, false, false],
		);
		assert.strictEqual(isTurnRunning({ isRunning: undefined }), false);
	});

	test('ход из Telegram сам сообщает ошибку, зависание и вопрос; остановку предохранителем — нет', () => {
		const kinds: AttentionKind[] = ['loopStopped', 'toolErrorsStopped', 'stalled', 'turnFailed', 'awaitingApproval', 'agentPaused'];
		assert.deepStrictEqual(
			kinds.map(isCoveredByTelegramRun),
			[false, false, true, true, true, false],
		);
	});

	test('получатели: настройка и живой мост обязательны, ход из Telegram — только его чат, из IDE — все привязанные', () => {
		const base = { notifyEnabled: true, bridgeLive: true, allowedChatIds: [10, 20, 10] };
		assert.deepStrictEqual(
			[
				selectAttentionRecipients(base),
				selectAttentionRecipients({ ...base, originChatId: 20 }),
				selectAttentionRecipients({ ...base, notifyEnabled: false }),
				selectAttentionRecipients({ ...base, bridgeLive: false }),
				selectAttentionRecipients({ ...base, allowedChatIds: [] }),
				selectAttentionRecipients({ ...base, originChatId: 20, bridgeLive: false }),
			],
			[[10, 20], [20], [], [], [], []],
		);
	});

	test('реестр: об одной остановке за ход одно сообщение, новый ход открывает следующее', () => {
		const ledger = new AttentionLedger();
		const stop = attentionClassKey('turnFailed');
		assert.deepStrictEqual(
			[
				ledger.claim('t1', stop),
				// Предохранитель и оставленная им ошибка в ленте — одна остановка
				ledger.claim('t1', attentionClassKey('loopStopped')),
				ledger.claim('t1', attentionClassKey('stalled')),
				// Другой тред — другой ход
				ledger.claim('t2', stop),
			],
			[true, false, false, true],
		);
		ledger.reset('t1');
		assert.deepStrictEqual([ledger.claim('t1', stop), ledger.claim('t2', stop)], [true, false]);
	});

	test('реестр: каждый вызов с вопросом разрешения — новое сообщение, повтор события — нет', () => {
		const ledger = new AttentionLedger();
		assert.deepStrictEqual(
			[
				ledger.claim('t1', attentionClassKey('awaitingApproval', 'call-1')),
				ledger.claim('t1', attentionClassKey('awaitingApproval', 'call-1')),
				ledger.claim('t1', attentionClassKey('awaitingApproval', 'call-2')),
				// Остановка и разрешение друг друга не заглушают
				ledger.claim('t1', attentionClassKey('turnFailed')),
			],
			[true, false, true, true],
		);
	});

	test('сторож: пауза сообщается один раз, снятие паузы разрешает следующую', () => {
		const ledger = new AttentionLedger();
		const paused = attentionClassKey('agentPaused');
		assert.deepStrictEqual([ledger.claim('task', paused), ledger.claim('task', paused)], [true, false]);
		ledger.reset('task');
		assert.strictEqual(ledger.claim('task', paused), true);
	});

	test('подпись треда: первое сообщение человека, в одну строку, с обрезкой', () => {
		const long = 'слово '.repeat(40);
		const label = threadLabelOf([{ role: 'assistant', displayContent: 'привет' }, { role: 'user', displayContent: long }]);
		assert.deepStrictEqual(
			[
				threadLabelOf([]),
				threadLabelOf([{ role: 'user', displayContent: '  ' }]),
				threadLabelOf([{ role: 'user', displayContent: 'почини\nтесты  сервера' }]),
				label?.length,
				label?.endsWith('…'),
			],
			[undefined, undefined, 'почини тесты сервера', ATTENTION_THREAD_LABEL_LIMIT + 1, true],
		);
	});

	test('подпись треда: обрезка не рвёт суррогатную пару', () => {
		const label = threadLabelOf([{ role: 'user', displayContent: 'a'.repeat(ATTENTION_THREAD_LABEL_LIMIT - 1) + '😀😀' }]);
		assert.strictEqual(label, 'a'.repeat(ATTENTION_THREAD_LABEL_LIMIT - 1) + '…');
	});

	test('текст: проект, тред, что случилось, причина, что сделать — по строке на мысль', () => {
		assert.strictEqual(
			formatAttentionMessage({ kind: 'turnFailed', project: 'VibeIDE', thread: 'почини тесты', detail: 'HTTP 529' }),
			[
				'⚠️ Агенту нужно внимание',
				'Проект: VibeIDE',
				'Тред: «почини тесты»',
				'Что случилось: ход закончился ошибкой и ждёт решения',
				'Причина: HTTP 529',
				'Что сделать: повторить ход или сменить модель либо провайдера',
			].join('\n'),
		);
	});

	test('текст: без проекта, треда и причины остаются заголовок и две строки; причина обрезается', () => {
		assert.strictEqual(
			formatAttentionMessage({ kind: 'loopStopped' }),
			[
				'⚠️ Агенту нужно внимание',
				'Что случилось: ход остановлен, агент повторял одно и то же действие',
				'Что сделать: открыть тред, переформулировать задачу или сменить модель',
			].join('\n'),
		);
		const cut = formatAttentionMessage({ kind: 'turnFailed', detail: 'x'.repeat(ATTENTION_DETAIL_LIMIT * 2) });
		assert.ok(cut.includes(`Причина: ${'x'.repeat(ATTENTION_DETAIL_LIMIT)}…`));
		assert.ok(!cut.includes('x'.repeat(ATTENTION_DETAIL_LIMIT + 1)));
	});

	test('текст: у каждого вида своё «что случилось» и «что сделать»', () => {
		const kinds: AttentionKind[] = ['loopStopped', 'toolErrorsStopped', 'stalled', 'turnFailed', 'awaitingApproval', 'agentPaused'];
		const bodies = kinds.map(kind => formatAttentionMessage({ kind }));
		assert.strictEqual(new Set(bodies).size, kinds.length);
		assert.ok(bodies.every(body => body.includes('Что случилось:') && body.includes('Что сделать:')));
	});
});
