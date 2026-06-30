/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { translateProviderError } from '../../common/providerErrorTranslator.js';

suite('providerErrorTranslator', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('translateProviderError — known families', () => {
		const cases: { name: string; input: string; expectRu: string }[] = [
			{ name: 'rate limit (OpenAI)', input: 'Rate limit reached for gpt-4o in organization org-x on tokens per min.', expectRu: 'частоту запросов' },
			// Quota family must win over rate-limit despite the «Rate limit exceeded» prefix
			// (observed openCodeGo Go monthly limit, retry-after ≈ 5 days).
			{ name: 'monthly usage quota (openCodeGo Go)', input: 'Rate limit exceeded: Monthly usage limit reached. Resets in 5 days. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_x/go', expectRu: 'квота за период' },
			{ name: 'GoUsageLimitError raw body', input: '{"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached."}}', expectRu: 'квота за период' },
			{ name: 'ended free promotion (openCodeGo 401)', input: 'Free promotion has ended for Qwen3.6 Plus Free. You can continue using the model by subscribing to OpenCode Go - https://opencode.ai/go', expectRu: 'подписка' },
			{ name: 'rate limit (429)', input: 'Request failed with status code 429', expectRu: 'частоту запросов' },
			{ name: 'overloaded (Anthropic)', input: 'Overloaded', expectRu: 'перегружен' },
			{ name: 'billing (OpenAI quota)', input: 'You exceeded your current quota, please check your plan and billing details.', expectRu: 'квота' },
			{ name: 'billing (insufficient credits)', input: 'Insufficient credits. Please top up your account.', expectRu: 'квота' },
			{ name: 'auth 401', input: 'Incorrect API key provided: sk-***. You can find your API key at...', expectRu: 'API-ключ' },
			{ name: 'auth invalid x-api-key', input: 'authentication_error: invalid x-api-key', expectRu: 'API-ключ' },
			{ name: 'forbidden 403', input: 'HTTP 403: permission denied for this endpoint', expectRu: '403' },
			{ name: 'model not found', input: 'The model `gpt-5-ultra` does not exist or you do not have access to it.', expectRu: 'Модель не найдена' },
			{ name: 'tools unsupported (OpenRouter free)', input: "No endpoints found that support the provided 'tool_choice' value. To learn more about provider routing, visit: https://openrouter.ai/docs", expectRu: 'не поддерживает вызов инструментов' },
			{ name: 'gateway 502', input: 'Bad gateway (502) from upstream', expectRu: '5xx' },
			{ name: 'gateway 520', input: 'Status 520: web server returned an unknown error', expectRu: '5xx' },
			{ name: 'timeout', input: 'Request timed out.', expectRu: 'время ожидания' },
			{ name: 'network ECONNREFUSED', input: 'connect ECONNREFUSED 127.0.0.1:11434', expectRu: 'Сетевая ошибка' },
			{ name: 'network fetch failed', input: 'TypeError: fetch failed', expectRu: 'Сетевая ошибка' },
			{ name: 'stream stalled (provider wording)', input: 'Stream stalled — no tokens received for 120s.', expectRu: 'Стрим оборвался' },
			{ name: 'context overflow (Anthropic raw)', input: 'prompt is too long: 250000 tokens > 200000 maximum', expectRu: 'контекстное окно' },
		];
		for (const c of cases) {
			test(c.name, () => {
				const out = translateProviderError(c.input);
				assert.ok(out, `expected a translation for: ${c.input}`);
				assert.ok(out.includes(c.expectRu), `expected «${c.expectRu}» in: ${out}`);
				assert.ok(out.includes('(исходно:'), 'original text must be echoed for bug reports');
			});
		}
	});

	suite('translateProviderError — pass-through', () => {
		test('null / empty / whitespace', () => {
			assert.strictEqual(translateProviderError(null), null);
			assert.strictEqual(translateProviderError(undefined), null);
			assert.strictEqual(translateProviderError(''), null);
			assert.strictEqual(translateProviderError('   '), null);
		});

		test('already Russian (our localized messages) is left alone', () => {
			assert.strictEqual(translateProviderError('Стрим завис — нет токенов уже 120с.'), null);
			assert.strictEqual(translateProviderError('Модель minimax через openCodeGo вернула пустой ответ 3 раз подряд.'), null);
		});

		test('unknown English error is left alone', () => {
			assert.strictEqual(translateProviderError('Something completely unexpected happened in flux capacitor.'), null);
		});

		test('long original is truncated in the echo', () => {
			const long = 'Rate limit reached. ' + 'x'.repeat(400);
			const out = translateProviderError(long);
			assert.ok(out);
			assert.ok(out.includes('…'), 'long original must be truncated');
			assert.ok(out.length < long.length + 120, 'echo must not blow the banner up');
		});
	});
});
