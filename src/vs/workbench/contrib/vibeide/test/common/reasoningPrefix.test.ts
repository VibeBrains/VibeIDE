/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { guardReasoningPrefix, ReasoningPrefixHead, reasoningPrefixHeadOf } from '../../common/reasoningPrefix.js';

type Msg = { role: 'user' | 'assistant' | 'tool'; content: string; anthropicReasoning?: { type: string; signature: string }[] | null; reasoningPrefix?: string };

/**
 * В режиме «выключено» Sonnet 5.5 (`between_tools`) запрос не может попросить вендора отбросить устаревший блок рассуждения
 * Блок, повторённый под изменённым префиксом, — 400; поэтому блоки срезаются с первого хода, чей префикс изменился
 */
suite('reasoning prefix — срез блоков рассуждения с изменённого хода', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const baseHead: ReasoningPrefixHead = { model: 'claude-sonnet-5-5', system: 'Ты агент.', instructions: '', chatMode: 'agent', extraTools: ['mcp_b', 'mcp_a'] };
	const thinking = (sig: string) => [{ type: 'thinking', signature: sig }];

	/** A conversation as the IDE builds it: each answer keeps the fingerprint of the request that produced it */
	const converse = (head: string) => {
		const history: Msg[] = [{ role: 'user', content: 'Прочитай файл' }];
		for (const turn of ['Читаю.', 'Правлю.']) {
			const { prefix } = guardReasoningPrefix(history, head, true);
			history.push({ role: 'assistant', content: turn, anthropicReasoning: thinking(turn), reasoningPrefix: prefix });
			history.push({ role: 'tool', content: `результат: ${turn}` });
		}
		return history;
	};
	const kept = (messages: readonly Msg[]) => messages.filter(m => m.role === 'assistant').map(m => !!m.anthropicReasoning);

	test('неизменный префикс — блоки остаются; изменённая шапка — срезаются все', () => {
		const head = reasoningPrefixHeadOf(baseHead);
		const history = converse(head);
		assert.deepStrictEqual({
			same: kept(guardReasoningPrefix(history, head, true).messages),
			toolOrder: reasoningPrefixHeadOf({ ...baseHead, extraTools: ['mcp_a', 'mcp_b'] }) === head,
			newRules: kept(guardReasoningPrefix(history, reasoningPrefixHeadOf({ ...baseHead, instructions: 'Новое правило' }), true).messages),
			otherModel: kept(guardReasoningPrefix(history, reasoningPrefixHeadOf({ ...baseHead, model: 'claude-opus-5-5' }), true).messages),
		}, {
			same: [true, true],
			toolOrder: true,
			newRules: [false, false],
			otherModel: [false, false],
		});
	});

	test('правка истории срезает блоки с изменённого хода и дальше, но не раньше', () => {
		const head = reasoningPrefixHeadOf(baseHead);
		const history = converse(head);
		// The first tool result was replaced by a stub (history compaction): the second answer was produced after it
		const compacted = history.map((m, i) => i === 2 ? { ...m, content: '[вывод сокращён]' } : m);
		const firstUserEdited = history.map((m, i) => i === 0 ? { ...m, content: 'Прочитай другой файл' } : m);
		assert.deepStrictEqual([kept(guardReasoningPrefix(compacted, head, true).messages), kept(guardReasoningPrefix(firstUserEdited, head, true).messages)], [
			[true, false],
			[false, false],
		]);
	});

	test('ход без записанного отпечатка не доказан — срезается; без режима среза история идёт как есть', () => {
		const head = reasoningPrefixHeadOf(baseHead);
		const legacy: Msg[] = [
			{ role: 'user', content: 'Прочитай файл' },
			{ role: 'assistant', content: 'Читаю.', anthropicReasoning: thinking('a') },
		];
		const stripped = guardReasoningPrefix(legacy, head, true);
		const untouched = guardReasoningPrefix(legacy, head, false);
		assert.deepStrictEqual({
			stripped: kept(stripped.messages),
			untouched: kept(untouched.messages),
			// The fingerprint is computed either way, so a later switch to «off» finds the turn already fingerprinted
			fingerprinted: typeof untouched.prefix === 'string' && untouched.prefix.length > 0,
		}, { stripped: [false], untouched: [true], fingerprinted: true });
	});
});
