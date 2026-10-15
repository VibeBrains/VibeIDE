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

	/**
	 * Вызов, написанный текстом, при нативных инструментах
	 * Несколько форм закрываются концом текста, поэтому оборванный ответ тоже читается как вызов
	 * Исполнять его нельзя: половина записи файла хуже, чем никакой
	 */
	test('вызов текстом: оборванный ответ ничего не исполняет, своё уведомление сохраняется, чужая догадка снимается', () => {
		const offered = { write_file: { type: 'object', properties: { content: { type: 'string' } } } };
		const cutText = 'Пишу файл.\n<tool_call>\n<function=write_file>\n<parameter=content>\nconst a = 1;\nconst';
		const finish = (fullText: string, finishNotice?: Parameters<OnFinalMessage>[0]['finishNotice']) => {
			let final: Parameters<OnFinalMessage>[0] | undefined;
			const { newOnFinalMessage } = grammar.extractTextToolCallsWrapper(() => { }, f => { final = f; }, offered, { providerName: 'p', modelName: 'm' });
			newOnFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null, ...(finishNotice ? { finishNotice } : {}) });
			return { call: final?.toolCall?.name, text: final?.fullText, notice: final?.finishNotice };
		};
		assert.deepStrictEqual({
			whole: finish(cutText),
			truncated: finish(cutText, { kind: 'truncated', by: 'output-limit' }),
			stalled: finish(cutText, { kind: 'stalled' }),
			guessed: finish('Так выглядит `<invoke name="x">` в тексте.', { kind: 'unparsedToolCall' }),
		}, {
			whole: { call: 'write_file', text: 'Пишу файл.', notice: undefined },
			truncated: { call: undefined, text: 'Пишу файл.', notice: { kind: 'truncated', by: 'output-limit', cutToolName: 'write_file' } },
			stalled: { call: undefined, text: 'Пишу файл.', notice: { kind: 'stalled', cutToolName: 'write_file' } },
			guessed: { call: undefined, text: 'Так выглядит `<invoke name="x">` в тексте.', notice: undefined },
		});
	});

	/**
	 * Тред владельца от 28.09.2026 (MiniMax-M3.1-Flash-Preview, Promed): вызов пришёл разметкой DSML без маркеров,
	 * с пробелом после `<` и `</` и обёрткой `calls`, и лежал в чате сырым текстом
	 * Вызов взят из сохранённого треда дословно, смешанная форма — сообщение 14 того же треда с укороченным путём
	 * Текст режется на куски по семь символов, как придёт из сети
	 */
	test('вызов текстом: DSML без маркеров из треда 28.09 исполняется, смешанная форма названа, разметки в потоке нет', () => {
		const offered = {
			ls_dir: { type: 'object', properties: { uri: { type: 'string' } } },
			run_command: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } } },
		};
		const wrap: Wrapper = (onText, onFinal) => grammar.extractTextToolCallsWrapper(onText, onFinal, offered, { providerName: 'minimax', modelName: 'MiniMax-M3.1-Flash-Preview' });
		const pieces = (text: string): Chunk[] => (text.match(/[\s\S]{1,7}/g) ?? []).map(piece => ({ text: piece }));
		const call = '< calls>\n< invoke name="ls_dir">\n< parameter name="uri" string="true">/Users/borodatych/Projects/VibeCode/Promed</ parameter>\n</ invoke>\n</ calls>';
		const mixed = '< calls>\n< invoke name="run_command">\n<command>git diff --stat | cat</command>\n<cwd>/p</cwd>\n</run_command>\n\n</parameter>';
		const marked = (shown: readonly string[]) => shown.some(text => /[<>]|calls|invoke|parameter/.test(text));
		const read = stream(wrap, pieces(call));
		const unread = stream(wrap, pieces(mixed));
		assert.deepStrictEqual({
			read: { call: read.final?.toolCall && `${read.final.toolCall.name} ${JSON.stringify(read.final.toolCall.rawParams)}`, text: read.final?.fullText, markupShown: marked(read.shown), notice: read.final?.finishNotice },
			unread: { call: unread.final?.toolCall, text: unread.final?.fullText, markupShown: marked(unread.shown), notice: unread.final?.finishNotice?.kind },
		}, {
			read: { call: 'ls_dir {"uri":"/Users/borodatych/Projects/VibeCode/Promed"}', text: '', markupShown: false, notice: undefined },
			unread: { call: undefined, text: '', markupShown: false, notice: 'unparsedToolCall' },
		});
	});
});
