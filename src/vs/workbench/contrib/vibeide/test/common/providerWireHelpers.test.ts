/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { googleRetryDelaySecondsOf } from '../../common/googleRetryInfo.js';
import { withBuiltinWireHints } from '../../common/builtinWireHints.js';
import { describeConnectionError } from '../../common/connectionErrorDiagnostics.js';

/**
 * Мелочи провода, перенесённые со старых путей и из файлов набора: пауза, которую Google называет в теле
 * ответа, объявления файла, правящего встроенного провайдера, и то, что на самом деле сломалось в сети.
 */
suite('provider wire helpers — пауза Google, объявления для встроенных, сетевой сбой', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('пауза из RetryInfo — в теле ошибки и во вложенной ошибке, иначе ничего', () => {
		const retryInfo = (delay: string) => ({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] } });
		assert.deepStrictEqual([
			googleRetryDelaySecondsOf(JSON.stringify(retryInfo('57.62s'))),
			googleRetryDelaySecondsOf(JSON.stringify({ error: { message: JSON.stringify(retryInfo('12s')) } })),
			googleRetryDelaySecondsOf(`[GoogleGenerativeAI Error]: ${JSON.stringify(retryInfo('3s'))}`),
			googleRetryDelaySecondsOf(JSON.stringify({ error: { code: 429, details: [] } })),
			googleRetryDelaySecondsOf('Too Many Requests'),
			googleRetryDelaySecondsOf(undefined),
		], [57.62, 12, 3, undefined, undefined, undefined]);
	});

	test('объявления файла вливаются во встроенного, ключ и адрес остаются его', () => {
		const settings = { openAI: { apiKey: 'sk', _didFillInProviderSettings: true }, xAI: { apiKey: 'xai' } };
		assert.deepStrictEqual(withBuiltinWireHints(settings, {
			openAI: { modelProtocols: { 'gpt-6-sol': 'openai-responses' }, promptCacheKey: true },
			// Встроенного с таким id в настройках нет — придумывать запись незачем.
			deepseek: { promptCacheKey: true },
		}), {
			openAI: { apiKey: 'sk', _didFillInProviderSettings: true, modelProtocols: { 'gpt-6-sol': 'openai-responses' }, promptCacheKey: true },
			xAI: { apiKey: 'xai' },
		});
		assert.strictEqual(withBuiltinWireHints(settings, {}), settings);
	});

	test('сетевой сбой называется по коду из цепочки причин; ошибка без кода — не сетевая', () => {
		const refused = Object.assign(new Error('Cannot connect to API: fetch failed'), {
			cause: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', errno: -61, syscall: 'connect', address: '127.0.0.1', port: 11434 } }),
		});
		assert.deepStrictEqual([
			describeConnectionError(refused),
			describeConnectionError(new Error('Bad Request')),
			describeConnectionError(undefined),
		], [
			'Cannot connect to API: fetch failed [code=ECONNREFUSED errno=-61 syscall=connect address=127.0.0.1 host=?:11434]',
			undefined,
			undefined,
		]);
	});
});
