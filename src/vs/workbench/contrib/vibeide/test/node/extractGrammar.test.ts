/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
// The wrappers live in electron-main next to the adapter that applies them; the Node runner is where they run
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import type * as GrammarModule from '../../electron-main/llmMessage/extractGrammar.js';
import type { OnFinalMessage, OnText } from '../../common/sendLLMMessageTypes.js';
import { skipInElectronRenderer } from './nodeOnly.js';

type Streamed = { readonly shown: string[]; readonly reasoning: string[]; final?: Parameters<OnFinalMessage>[0] };
type Wrapper = (onText: OnText, onFinalMessage: OnFinalMessage) => { newOnText: OnText; newOnFinalMessage: OnFinalMessage };
type Chunk = { readonly text: string; readonly reasoning?: string };

/**
 * Обёртки потока ответа: что видит читатель, пока ответ идёт, и что остаётся в итоге хода
 * Поток подаётся накопленным текстом, как его отдаёт адаптер
 */
suite('extractGrammar — обёртки потока ответа', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let grammar: typeof GrammarModule;

	suiteSetup(async function () {
		skipInElectronRenderer(this);
		grammar = await import('../../electron-main/llmMessage/extractGrammar.js');
	});

	const stream = (wrap: Wrapper, chunks: readonly Chunk[]): Streamed => {
		const out: Streamed = { shown: [], reasoning: [] };
		const { newOnText, newOnFinalMessage } = wrap(
			({ fullText, fullReasoning }) => { out.shown.push(fullText); out.reasoning.push(fullReasoning); },
			final => { out.final = final; },
		);
		let text = '';
		let reasoning = '';
		for (const chunk of chunks) {
			text += chunk.text;
			reasoning += chunk.reasoning ?? '';
			newOnText({ fullText: text, fullReasoning: reasoning });
		}
		newOnFinalMessage({ fullText: text, fullReasoning: reasoning, anthropicReasoning: null });
		return out;
	};

	/**
	 * Разбор `<think>` из текста у модели, которая шлёт рассуждение и своим полем
	 * Разбор затирал родное рассуждение своим результатом, и без тегов в тексте оно пропадало целиком
	 */
	test('рассуждение своим полем проходит мимо разбора тегов и складывается с ним', () => {
		const wrap: Wrapper = (onText, onFinal) => grammar.extractReasoningWrapper(onText, onFinal, ['<think>', '</think>']);
		const nativeOnly = stream(wrap, [{ text: '', reasoning: 'Проверю ветку.' }, { text: 'На ветке next.' }]);
		const both = stream(wrap, [{ text: '<think>Смотрю лог.', reasoning: 'Проверю ветку.' }, { text: '</think>На ветке next.' }]);
		assert.deepStrictEqual({
			nativeOnly: { text: nativeOnly.final?.fullText, reasoning: nativeOnly.final?.fullReasoning, streamed: nativeOnly.reasoning.at(-1) },
			both: { text: both.final?.fullText, reasoning: both.final?.fullReasoning, streamed: both.reasoning.at(-1) },
		}, {
			nativeOnly: { text: 'На ветке next.', reasoning: 'Проверю ветку.', streamed: 'Проверю ветку.' },
			both: { text: 'На ветке next.', reasoning: 'Проверю ветку.\n\nСмотрю лог.', streamed: 'Проверю ветку.\n\nСмотрю лог.' },
		});
	});

	/**
	 * XML-режим: блок `invoke` открыт, но ещё не закрыт
	 * Нормализатор переписывает блок только после `</invoke>`, и до тех пор зачистка снимала теги и показывала значения
	 */
	test('XML-режим: значение незакрытого вызова не мелькает, оборванный вызов назван, задержанная проза не теряется', () => {
		const wrap: Wrapper = (onText, onFinal) => grammar.extractXMLToolsWrapper(onText, onFinal, 'agent', undefined);
		const closed = stream(wrap, [
			{ text: 'Смотрю файл.\n<invoke name="read_file">' },
			{ text: '<parameter name="uri">src/ma' },
			{ text: 'in.ts</parameter></invoke>' },
		]);
		const cut = stream(wrap, [
			{ text: 'Смотрю файл.\n<invoke name="read_file">' },
			{ text: '<parameter name="uri">src/ma' },
		]);
		const heldProse = stream(wrap, [{ text: 'Сравни a ' }, { text: '<' }]);
		const valueShown = (shown: readonly string[]) => shown.some(text => /src\/ma|uri|invoke|parameter/.test(text));
		assert.deepStrictEqual({
			closed: { valueShown: valueShown(closed.shown), call: closed.final?.toolCall && `${closed.final.toolCall.name} ${JSON.stringify(closed.final.toolCall.rawParams)}`, text: closed.final?.fullText },
			cut: { valueShown: valueShown(cut.shown), call: cut.final?.toolCall, notice: cut.final?.finishNotice?.kind, text: cut.final?.fullText },
			heldProse: heldProse.final?.fullText,
		}, {
			closed: { valueShown: false, call: 'read_file {"uri":"src/main.ts"}', text: 'Смотрю файл.' },
			cut: { valueShown: false, call: undefined, notice: 'unparsedToolCall', text: 'Смотрю файл.\n\n*[вызов инструмента — некорректный формат от модели, скрыто]*\n' },
			heldProse: 'Сравни a <',
		});
	});
});
