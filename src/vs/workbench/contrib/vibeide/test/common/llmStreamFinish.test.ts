/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AnthropicReasoningCollector, describeFinishNotice, finishNoticeOf } from '../../common/llmStreamFinish.js';

/**
 * Конец потока: почему модель остановилась и какие подписанные блоки рассуждения Claude можно вернуть.
 * Обе вещи SDK сообщает, но раньше их никто не читал: отказ выглядел пустым ответом, обрыв — законченным.
 */
suite('llmStreamFinish — причина остановки и блоки рассуждения', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('отказ с категорией, обрыв по лимиту вывода и по окну контекста, обычный конец', () => {
		assert.deepStrictEqual([
			finishNoticeOf('content-filter', 'refusal', { anthropic: { stopDetails: { type: 'refusal', category: 'bio', explanation: 'Классификатор' } } }),
			finishNoticeOf('content-filter', 'content_filter', { openai: {} }),
			finishNoticeOf('length', 'max_tokens', undefined),
			finishNoticeOf('length', 'model_context_window_exceeded', undefined),
			finishNoticeOf('stop', 'end_turn', undefined),
			finishNoticeOf('tool-calls', 'tool_use', undefined),
			finishNoticeOf(null, undefined, undefined),
		], [
			{ kind: 'refusal', category: 'bio', explanation: 'Классификатор' },
			{ kind: 'refusal' },
			{ kind: 'truncated', by: 'output-limit' },
			{ kind: 'truncated', by: 'context-window' },
			undefined,
			undefined,
			undefined,
		]);
	});

	test('блоки в порядке потока: с подписью, скрытые и неподписанные с текстом; пустой неподписанный отброшен', () => {
		const collector = new AnthropicReasoningCollector();
		collector.start('0', undefined);
		collector.delta('0', 'Сначала прочту ', undefined);
		collector.delta('0', 'файл.', undefined);
		collector.delta('0', '', { anthropic: { signature: 'sig-0' } });
		collector.end('0', undefined);
		collector.start('1', { anthropic: { redactedData: 'opaque' } });
		collector.end('1', undefined);
		// Под показом `omitted` блок приходит без слов, но с подписью — он действителен.
		collector.start('2', undefined);
		collector.end('2', { anthropic: { signature: 'sig-2' } });
		// Без подписи: так пишут Kimi, MiMo и DeepSeek, так же выглядит оборванный поток Claude — решает провод.
		collector.start('3', undefined);
		collector.delta('3', 'недодумал', undefined);
		// Ни слов, ни подписи — возвращать нечего.
		collector.start('4', undefined);
		collector.end('4', undefined);
		assert.deepStrictEqual(collector.blocks(), [
			{ type: 'thinking', thinking: 'Сначала прочту файл.', signature: 'sig-0' },
			{ type: 'redacted_thinking', data: 'opaque' },
			{ type: 'thinking', thinking: '', signature: 'sig-2' },
			{ type: 'thinking', thinking: 'недодумал' },
		]);
		assert.strictEqual(new AnthropicReasoningCollector().blocks(), null);
	});

	test('текст уведомления в чате — по полям, построчно, с оборванным вызовом', () => {
		assert.deepStrictEqual([
			describeFinishNotice({ kind: 'refusal', category: 'cyber' }),
			describeFinishNotice({ kind: 'truncated', by: 'output-limit', cutToolName: 'write_file' }),
			describeFinishNotice({ kind: 'truncated', by: 'context-window' }),
			describeFinishNotice({ kind: 'stalled', cutToolName: 'edit_file' }),
		], [
			'**Модель отказалась продолжать:** сработал фильтр безопасности вендора (cyber)',
			'**Ответ оборван лимитом вывода модели**\n\nМодель не договорила — продолжите ход или поднимите лимит вывода модели\n\nВызов инструмента `write_file` оборван посреди аргументов и не выполнен',
			'**Ответ оборван: переполнено окно контекста модели**\n\nСожмите историю или выберите модель с окном больше',
			'**Поток ответа замолчал и был прерван**\n\nПоказано то, что успело прийти\n\nВызов инструмента `edit_file` оборван посреди аргументов и не выполнен',
		]);
	});
});
