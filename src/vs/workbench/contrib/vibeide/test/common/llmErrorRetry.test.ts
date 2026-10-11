/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decideLlmRetry, firstRetryAfterSeconds, formatWaitDuration, LlmErrorFacts, LlmRetryContext, LlmRetryDecision, parseRetryAfterSeconds } from '../../common/llmErrorRetry.js';
import { buildContextOverflowError, buildEmptyResponseError } from '../../common/sendLLMMessageTypes.js';

suite('LLM error retry', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const base: LlmErrorFacts = { message: '', safetyRefusal: false, emptyBreakerTripped: false, canSwitchModel: false, rateLimit: false };
	const first: LlmRetryContext = {
		attempt: 1,
		isLocalProvider: false,
		rateLimitWaitAvailable: false,
		rateLimitPaused: false,
		maxRetries: 3,
		retryInitialDelayMs: 1000,
		retryMaxDelayMs: 5000,
	};

	const words = (decision: LlmRetryDecision): string => {
		switch (decision.kind) {
			case 'stop': return `stop:${decision.reason}`;
			case 'retry': return `retry ${decision.delayMs}ms (${decision.cause} ${decision.retryNumber}/${decision.retriesPlanned})`;
			case 'autoWait': return 'autoWait';
			case 'nextModel': return decision.skipFailedProvider ? 'nextModel, not this provider' : 'nextModel';
		}
	};
	/** The decision for each attempt in turn, as the loop would meet them */
	const attempts = (facts: Partial<LlmErrorFacts>, context: Partial<LlmRetryContext> = {}, count = 4) =>
		Array.from({ length: count }, (_, i) => words(decideLlmRetry({ ...base, ...facts }, { ...first, ...context, attempt: i + 1 })));

	test('какие ошибки модели не повторяются совсем: закреплённая модель и Авто', () => {
		const errors: Record<string, Partial<LlmErrorFacts>> = {
			'успешный ответ не разобран': { message: 'Failed to process successful response', httpStatus: 200 },
			'шлюз 520': { message: 'Provider unavailable (HTTP 520) for openCode/minimax-m2.7', httpStatus: 520 },
			'сервис недоступен 503': { message: 'Service Unavailable', httpStatus: 503 },
			'соединение сброшено': { message: 'fetch failed: read ECONNRESET' },
			'поток оборван': { message: 'terminated' },
			'пустой ответ, предохранитель цел': { message: buildEmptyResponseError('openCode', 'minimax-m2.7', 'unknown') },
			'таймаут запроса 408': { message: 'Request Timeout', httpStatus: 408 },
			'лимит запросов 429': { message: 'Too Many Requests', httpStatus: 429, rateLimit: true },
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
		const stops = (facts: Partial<LlmErrorFacts>, canSwitchModel: boolean) => decideLlmRetry({ ...base, ...facts, canSwitchModel }, first).kind === 'stop';
		const verdicts = Object.fromEntries(Object.entries(errors).map(([name, facts]) => [name, {
			закреплённая: stops(facts, false) ? 'стоп' : 'повтор',
			авто: stops(facts, true) ? 'стоп' : 'повтор',
		}]));
		const retry = { закреплённая: 'повтор', авто: 'повтор' };
		const stop = { закреплённая: 'стоп', авто: 'стоп' };
		// A 4xx is about the request, so only another model can answer it differently
		const nextModelOnly = { закреплённая: 'стоп', авто: 'повтор' };
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

	test('закреплённая модель, облако: класс ошибки × номер попытки × Retry-After', () => {
		const server = { message: 'Provider unavailable (HTTP 503) for fake/m', httpStatus: 503 };
		const throttled = { message: 'Rate limit exceeded: slow down', httpStatus: 429, rateLimit: true };
		assert.deepStrictEqual({
			'сервер 500': attempts({ message: 'Provider unavailable (HTTP 500) for fake/m', httpStatus: 500 }),
			'сервер 503, код только в тексте': attempts({ message: 'Provider unavailable (HTTP 503) for fake/m' }),
			'сеть: соединение отклонено': attempts({ message: 'Failed to connect to Fake. (ECONNREFUSED)' }),
			'ответ 200 не разобран': attempts({ message: 'Failed to process successful response', httpStatus: 200 }),
			'сервер 503, Retry-After 2': attempts({ ...server, retryAfterSeconds: 2 }),
			'сервер 503, Retry-After 30': attempts({ ...server, retryAfterSeconds: 30 }, {}, 1),
			'сервер 503, Retry-After 45': attempts({ ...server, retryAfterSeconds: 45 }, {}, 2),
			'429 без Retry-After, пауза доступна': attempts(throttled, { rateLimitWaitAvailable: true }),
			'429 без Retry-After, пауза недоступна': attempts(throttled),
			'429 без Retry-After, пауза уже была': attempts(throttled, { rateLimitWaitAvailable: true, rateLimitPaused: true }, 2),
			'429, Retry-After 3, пауза доступна': attempts({ ...throttled, retryAfterSeconds: 3 }, { rateLimitWaitAvailable: true }, 2),
			'429, Retry-After 3, пауза недоступна': attempts({ ...throttled, retryAfterSeconds: 3 }),
			'429, Retry-After 45, пауза недоступна': attempts({ ...throttled, retryAfterSeconds: 45 }, {}, 1),
			'ключ не принят 401': attempts({ message: 'Unauthorized', httpStatus: 401 }, {}, 1),
			'контекст не влез': attempts({ message: 'prompt is too long: 215000 tokens > 200000 maximum' }, {}, 1),
		}, {
			'сервер 500': ['retry 1000ms (serverError 1/3)', 'retry 2000ms (serverError 2/3)', 'retry 4000ms (serverError 3/3)', 'stop:retriesSpent'],
			'сервер 503, код только в тексте': ['retry 1000ms (serverError 1/3)', 'retry 2000ms (serverError 2/3)', 'retry 4000ms (serverError 3/3)', 'stop:retriesSpent'],
			'сеть: соединение отклонено': ['retry 1000ms (network 1/3)', 'retry 2000ms (network 2/3)', 'retry 4000ms (network 3/3)', 'stop:retriesSpent'],
			'ответ 200 не разобран': ['retry 1000ms (transient 1/3)', 'retry 2000ms (transient 2/3)', 'retry 4000ms (transient 3/3)', 'stop:retriesSpent'],
			'сервер 503, Retry-After 2': ['retry 2000ms (serverError 1/3)', 'retry 2000ms (serverError 2/3)', 'retry 4000ms (serverError 3/3)', 'stop:retriesSpent'],
			'сервер 503, Retry-After 30': ['retry 30000ms (serverError 1/3)'],
			'сервер 503, Retry-After 45': ['stop:retryAfterTooLong', 'stop:retryAfterTooLong'],
			'429 без Retry-After, пауза доступна': ['retry 2000ms (rateLimit 1/2)', 'retry 4000ms (rateLimit 2/2)', 'autoWait', 'autoWait'],
			'429 без Retry-After, пауза недоступна': ['retry 2000ms (rateLimit 1/2)', 'retry 4000ms (rateLimit 2/2)', 'retry 4000ms (rateLimit 3/3)', 'stop:retriesSpent'],
			'429 без Retry-After, пауза уже была': ['autoWait', 'autoWait'],
			'429, Retry-After 3, пауза доступна': ['autoWait', 'autoWait'],
			'429, Retry-After 3, пауза недоступна': ['retry 3000ms (rateLimit 1/3)', 'retry 3000ms (rateLimit 2/3)', 'retry 4000ms (rateLimit 3/3)', 'stop:retriesSpent'],
			'429, Retry-After 45, пауза недоступна': ['stop:retryAfterTooLong'],
			'ключ не принят 401': ['stop:notRetryable'],
			'контекст не влез': ['stop:notRetryable'],
		});
	});

	test('настройки и локальный провайдер: потолок задержки, число повторов, короткий старт', () => {
		const server = { message: 'Provider unavailable (HTTP 500) for fake/m', httpStatus: 500 };
		const throttled = { message: 'Rate limit exceeded: slow down', httpStatus: 429, rateLimit: true };
		assert.deepStrictEqual({
			'локальный провайдер': attempts(server, { isLocalProvider: true }, 3),
			'потолок задержки 1500 мс': attempts(server, { retryMaxDelayMs: 1500 }, 3),
			'повторов нет': attempts(server, { maxRetries: 0 }, 1),
			'один повтор': attempts(server, { maxRetries: 1 }, 2),
			'429, повторов нет, пауза недоступна': attempts(throttled, { maxRetries: 0 }, 1),
			'429, повторов нет, пауза доступна': attempts(throttled, { maxRetries: 0, rateLimitWaitAvailable: true }, 1),
			'429, один повтор, пауза недоступна': attempts(throttled, { maxRetries: 1 }, 2),
		}, {
			'локальный провайдер': ['retry 500ms (serverError 1/3)', 'retry 1000ms (serverError 2/3)', 'retry 2000ms (serverError 3/3)'],
			'потолок задержки 1500 мс': ['retry 1000ms (serverError 1/3)', 'retry 1500ms (serverError 2/3)', 'retry 1500ms (serverError 3/3)'],
			'повторов нет': ['stop:retriesSpent'],
			'один повтор': ['retry 1000ms (serverError 1/1)', 'stop:retriesSpent'],
			'429, повторов нет, пауза недоступна': ['stop:retriesSpent'],
			'429, повторов нет, пауза доступна': ['autoWait'],
			'429, один повтор, пауза недоступна': ['retry 2000ms (rateLimit 1/1)', 'stop:retriesSpent'],
		});
	});

	test('Авто: следующая модель, а при падении самого провайдера — не его модели', () => {
		const auto = { canSwitchModel: true };
		const throttled = { message: 'Rate limit exceeded: slow down', httpStatus: 429, rateLimit: true };
		assert.deepStrictEqual({
			'сервер 500': attempts({ ...auto, message: 'Provider unavailable (HTTP 500) for fake/m', httpStatus: 500 }, {}, 1),
			'сервер 503, Retry-After 45': attempts({ ...auto, message: 'Provider unavailable (HTTP 503) for fake/m', httpStatus: 503, retryAfterSeconds: 45 }, {}, 1),
			'сеть: соединение отклонено': attempts({ ...auto, message: 'Failed to connect to Fake. (ECONNREFUSED)' }, {}, 1),
			'ответ 200 не разобран': attempts({ ...auto, message: 'Failed to process successful response', httpStatus: 200 }, {}, 1),
			'отказ 400': attempts({ ...auto, message: 'Rejected', httpStatus: 400 }, {}, 1),
			'контекст не влез': attempts({ ...auto, message: 'prompt is too long: 215000 tokens > 200000 maximum' }, {}, 1),
			'429 без Retry-After, пауза доступна': attempts({ ...auto, ...throttled }, { rateLimitWaitAvailable: true }),
			'429 без Retry-After, пауза недоступна': attempts({ ...auto, ...throttled }, {}, 3),
		}, {
			'сервер 500': ['nextModel, not this provider'],
			'сервер 503, Retry-After 45': ['nextModel, not this provider'],
			'сеть: соединение отклонено': ['nextModel, not this provider'],
			'ответ 200 не разобран': ['nextModel'],
			'отказ 400': ['nextModel'],
			'контекст не влез': ['stop:notRetryable'],
			'429 без Retry-After, пауза доступна': ['retry 2000ms (rateLimit 1/2)', 'retry 4000ms (rateLimit 2/2)', 'autoWait', 'autoWait'],
			'429 без Retry-After, пауза недоступна': ['retry 2000ms (rateLimit 1/2)', 'retry 4000ms (rateLimit 2/2)', 'nextModel'],
		});
	});

	test('Retry-After: секунды, дата, мусор; первый годный из заголовков ошибки', () => {
		const now = Date.parse('2026-10-10T12:00:00Z');
		assert.deepStrictEqual({
			секунды: parseRetryAfterSeconds('45', now),
			дробные: parseRetryAfterSeconds('2.5', now),
			ноль: parseRetryAfterSeconds('0', now),
			пусто: parseRetryAfterSeconds('', now),
			мусор: parseRetryAfterSeconds('soon', now),
			дата: parseRetryAfterSeconds('Sat, 10 Oct 2026 12:00:30 GMT', now),
			'дата в прошлом': parseRetryAfterSeconds('Sat, 10 Oct 2026 11:59:00 GMT', now),
			'первый годный': firstRetryAfterSeconds([undefined, { 'retry-after': 'soon' }, { 'retry-after': '7' }, { 'retry-after': '9' }], now),
			'ни одного': firstRetryAfterSeconds([undefined, {}], now),
		}, {
			секунды: 45,
			дробные: 2.5,
			ноль: undefined,
			пусто: undefined,
			мусор: undefined,
			дата: 30,
			'дата в прошлом': undefined,
			'первый годный': 7,
			'ни одного': undefined,
		});
	});

	test('срок ожидания словами: секунды, минуты, часы, сутки', () => {
		assert.deepStrictEqual([45, 119, 300, 7199, 7200, 3 * 3600, 453966].map(formatWaitDuration), ['45 с', '119 с', '5 мин', '120 мин', '2 ч', '3 ч', '5 сут']);
	});
});
