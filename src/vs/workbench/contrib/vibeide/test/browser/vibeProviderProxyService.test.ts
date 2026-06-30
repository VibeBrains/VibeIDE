/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PROXY_REDACT_HEADER_NAMES,
	redactAuthHeaders,
} from '../../browser/vibeProviderProxyService.js';

suite('VibeProviderProxyService — redactAuthHeaders', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('PROXY_REDACT_HEADER_NAMES is frozen and lowercase', () => {
		assert.ok(Object.isFrozen(PROXY_REDACT_HEADER_NAMES));
		for (const name of PROXY_REDACT_HEADER_NAMES) {
			assert.strictEqual(name, name.toLowerCase());
		}
	});

	test('Authorization is redacted', () => {
		const out = redactAuthHeaders({ Authorization: 'Bearer eyJabc.def.ghi' });
		assert.strictEqual(out.Authorization, '[REDACTED]');
	});

	test('case-insensitive match (AUTHORIZATION, authorization)', () => {
		assert.strictEqual(redactAuthHeaders({ AUTHORIZATION: 'x' }).AUTHORIZATION, '[REDACTED]');
		assert.strictEqual(redactAuthHeaders({ authorization: 'x' }).authorization, '[REDACTED]');
		assert.strictEqual(redactAuthHeaders({ Authorization: 'x' }).Authorization, '[REDACTED]');
	});

	test('x-api-key family redacted', () => {
		const out = redactAuthHeaders({
			'x-api-key': 'sk-…',
			'X-OpenAI-Api-Key': 'sk-…',
			'x-goog-api-key': 'AIza…',
			'anthropic-api-key': 'sk-ant-…',
		});
		assert.strictEqual(out['x-api-key'], '[REDACTED]');
		assert.strictEqual(out['X-OpenAI-Api-Key'], '[REDACTED]');
		assert.strictEqual(out['x-goog-api-key'], '[REDACTED]');
		assert.strictEqual(out['anthropic-api-key'], '[REDACTED]');
	});

	test('Cookie / Set-Cookie redacted', () => {
		const out = redactAuthHeaders({
			Cookie: 'session=abc',
			'Set-Cookie': 'session=abc; Path=/',
		});
		assert.strictEqual(out.Cookie, '[REDACTED]');
		assert.strictEqual(out['Set-Cookie'], '[REDACTED]');
	});

	test('non-sensitive headers pass through unchanged', () => {
		const out = redactAuthHeaders({
			'Content-Type': 'application/json',
			'User-Agent': 'VibeIDE/0.2.0',
			'X-Request-Id': 'abc-123',
		});
		assert.strictEqual(out['Content-Type'], 'application/json');
		assert.strictEqual(out['User-Agent'], 'VibeIDE/0.2.0');
		assert.strictEqual(out['X-Request-Id'], 'abc-123');
	});

	test('original casing preserved on output', () => {
		const out = redactAuthHeaders({ 'Content-Type': 'application/json' });
		assert.ok(Object.prototype.hasOwnProperty.call(out, 'Content-Type'));
		assert.ok(!Object.prototype.hasOwnProperty.call(out, 'content-type'));
	});

	test('non-string value is coerced to placeholder', () => {
		const headers = { 'X-Custom': 42 as unknown as string };
		const out = redactAuthHeaders(headers);
		assert.strictEqual(out['X-Custom'], '[non-string-value]');
	});

	test('empty input returns empty object', () => {
		assert.deepStrictEqual(redactAuthHeaders({}), {});
	});

	test('proxy-authorization redacted (the K.2 missing case)', () => {
		const out = redactAuthHeaders({ 'Proxy-Authorization': 'Basic dXNlcjpwYXNz' });
		assert.strictEqual(out['Proxy-Authorization'], '[REDACTED]');
	});
});
