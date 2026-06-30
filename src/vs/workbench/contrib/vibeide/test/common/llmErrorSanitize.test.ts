/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { sanitizeLlmErrorForLog } from '../../common/llmErrorSanitize.js';

const SECRET = 'COOKIE_VALIDATION_KEY=super-secret-value';

suite('sanitizeLlmErrorForLog — strip echoed prompt payload from LLM error logs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('omits requestBodyValues (the full prompt) but keeps diagnostic fields', () => {
		const err = {
			name: 'AI_APICallError',
			message: 'Rate limit exceeded',
			url: 'https://opencode.ai/zen/go/v1/chat/completions',
			requestBodyValues: { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: SECRET }] },
		};
		const out = sanitizeLlmErrorForLog(err);
		assert.ok(!out.includes(SECRET), 'secret prompt content must not leak');
		assert.ok(out.includes('[omitted: request payload]'), 'payload should be replaced by marker');
		assert.ok(out.includes('Rate limit exceeded'), 'error message kept');
		assert.ok(out.includes('AI_APICallError'), 'error name kept');
		assert.ok(out.includes('opencode.ai'), 'url kept');
	});

	test('omits nested messages / prompt arrays at any depth', () => {
		const err = { fullError: { errors: [{ messages: [{ content: SECRET }], prompt: SECRET }] } };
		const out = sanitizeLlmErrorForLog(err);
		assert.ok(!out.includes(SECRET), 'nested payload must not leak');
	});

	test('degrades a circular reference to a marker instead of throwing', () => {
		const a: Record<string, unknown> = { name: 'E', message: 'boom' };
		a.self = a;
		const out = sanitizeLlmErrorForLog(a);
		assert.ok(out.includes('boom'), 'still serializes the non-circular fields');
		assert.ok(out.includes('[circular]'), 'cycle replaced by marker');
	});

	test('handles non-object / string / undefined inputs', () => {
		assert.strictEqual(sanitizeLlmErrorForLog('boom'), '"boom"');
		assert.strictEqual(typeof sanitizeLlmErrorForLog(undefined), 'string');
		assert.strictEqual(sanitizeLlmErrorForLog(undefined), '[empty LLM error]');
	});
});
