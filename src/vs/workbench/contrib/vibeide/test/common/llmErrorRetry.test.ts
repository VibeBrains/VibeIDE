/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isRetryableLlmError, LlmErrorFacts } from '../../common/llmErrorRetry.js';
import { buildContextOverflowError, buildEmptyResponseError } from '../../common/sendLLMMessageTypes.js';

suite('LLM error retry', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const base: LlmErrorFacts = { message: '', safetyRefusal: false, emptyBreakerTripped: false, canSwitchModel: false };

	test('какие ошибки модели повторяются: закреплённая модель и Авто', () => {
		const errors: Record<string, Partial<LlmErrorFacts>> = {
			// HTTP 200 with a body the SDK could not read: the case that left a run dead until the person typed again
			'успешный ответ не разобран': { message: 'Failed to process successful response', httpStatus: 200 },
			'шлюз 520': { message: 'Provider unavailable (HTTP 520) for openCode/minimax-m2.7', httpStatus: 520 },
			'сервис недоступен 503': { message: 'Service Unavailable', httpStatus: 503 },
			'соединение сброшено': { message: 'fetch failed: read ECONNRESET' },
			'поток оборван': { message: 'terminated' },
			'пустой ответ, предохранитель цел': { message: buildEmptyResponseError('openCode', 'minimax-m2.7', 'unknown') },
			'таймаут запроса 408': { message: 'Request Timeout', httpStatus: 408 },
			'лимит запросов 429': { message: 'Too Many Requests', httpStatus: 429 },
			'контекст не влез, шаблон': { message: buildContextOverflowError('someProvider', 'some-model', 'prompt is too long') },
			'контекст не влез, сырой текст': { message: 'prompt is too long: 215000 tokens > 200000 maximum' },
			'квота исчерпана': { message: 'Quota exhausted', refusalKind: 'quota' },
			'отказ по безопасности': { message: 'The request was declined', safetyRefusal: true },
			'предохранитель пустых ответов сработал': { message: buildEmptyResponseError('openCode', 'minimax-m2.7', 'unknown'), emptyBreakerTripped: true },
			'отказ 400': { message: 'Rejected', httpStatus: 400 },
			'ключ не принят 401': { message: 'Unauthorized', httpStatus: 401 },
			'нужна оплата 402': { message: 'Payment Required', httpStatus: 402 },
			'модель не найдена 404': { message: 'Not Found', httpStatus: 404 },
		};
		const verdicts = Object.fromEntries(Object.entries(errors).map(([name, facts]) => [name, {
			закреплённая: isRetryableLlmError({ ...base, ...facts }),
			авто: isRetryableLlmError({ ...base, ...facts, canSwitchModel: true }),
		}]));
		const retry = { закреплённая: true, авто: true };
		const stop = { закреплённая: false, авто: false };
		// A 4xx is about the request, so only another model can answer it differently
		const nextModelOnly = { закреплённая: false, авто: true };
		assert.deepStrictEqual(verdicts, {
			'успешный ответ не разобран': retry,
			'шлюз 520': retry,
			'сервис недоступен 503': retry,
			'соединение сброшено': retry,
			'поток оборван': retry,
			'пустой ответ, предохранитель цел': retry,
			'таймаут запроса 408': retry,
			'лимит запросов 429': retry,
			'контекст не влез, шаблон': stop,
			'контекст не влез, сырой текст': stop,
			'квота исчерпана': stop,
			'отказ по безопасности': stop,
			'предохранитель пустых ответов сработал': stop,
			'отказ 400': nextModelOnly,
			'ключ не принят 401': nextModelOnly,
			'нужна оплата 402': nextModelOnly,
			'модель не найдена 404': nextModelOnly,
		});
	});
});
