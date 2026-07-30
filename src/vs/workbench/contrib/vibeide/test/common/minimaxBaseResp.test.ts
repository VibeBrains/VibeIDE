/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	classifyMiniMaxBaseResp,
	extractMiniMaxBaseResp,
	isMiniMaxThrottleKind,
	readMiniMaxRefusal,
} from '../../common/minimaxBaseResp.js';

suite('minimaxBaseResp', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('success sentinel classifies as ok', () => {
		assert.deepStrictEqual(classifyMiniMaxBaseResp({ code: 0 }), { code: 0, kind: 'ok', ambiguous: false });
	});

	test('undisputed codes map without ambiguity', () => {
		const verdicts = [1041, 2045, 2056, 1028, 1008, 1004, 2061, 1024, 1001, 2013, 1027]
			.map(code => classifyMiniMaxBaseResp({ code }))
			.map(v => `${v.code}:${v.kind}:${v.ambiguous}`);

		assert.deepStrictEqual(verdicts, [
			'1041:rate-limit:false',
			'2045:rate-limit:false',
			'2056:quota:false',
			'1028:quota:false',
			'1008:quota:false',
			'1004:auth:false',
			'2061:auth:false',
			'1024:server:false',
			'1001:timeout:false',
			'2013:invalid-params:false',
			'1027:content-filter:false',
		]);
	});

	test('disputed 1002/1039 follow the API error table but stay flagged when the message is silent', () => {
		// The vendor's own CLI calls these a sensitivity filter while the API error table calls
		// them limits — with no wording to go on we keep the table's reading AND admit the doubt.
		assert.deepStrictEqual(classifyMiniMaxBaseResp({ code: 1002 }), { code: 1002, kind: 'rate-limit', ambiguous: true });
		assert.deepStrictEqual(classifyMiniMaxBaseResp({ code: 1039 }), { code: 1039, kind: 'quota', ambiguous: true });
	});

	test('message wording breaks the 1002 tie in both directions', () => {
		assert.deepStrictEqual(
			classifyMiniMaxBaseResp({ code: 1002, message: 'Input content flagged by sensitivity filter' }),
			{ code: 1002, message: 'Input content flagged by sensitivity filter', kind: 'content-filter', ambiguous: true },
		);
		assert.deepStrictEqual(
			classifyMiniMaxBaseResp({ code: 1002, message: 'rate limit reached, please retry' }),
			{ code: 1002, message: 'rate limit reached, please retry', kind: 'rate-limit', ambiguous: false },
		);
	});

	test('unknown codes stay unknown rather than guessing a bucket', () => {
		assert.deepStrictEqual(classifyMiniMaxBaseResp({ code: 9999 }), { code: 9999, kind: 'unknown', ambiguous: false });
	});

	test('throttle predicate covers both allowance flavours', () => {
		assert.deepStrictEqual(
			(['rate-limit', 'quota', 'content-filter', 'ok', 'server'] as const).map(isMiniMaxThrottleKind),
			[true, true, false, false, false],
		);
	});

	test('extracts base_resp from a plain JSON error body', () => {
		const body = JSON.stringify({ id: 'x', base_resp: { status_code: 1002, status_msg: 'rate limit' } });
		assert.deepStrictEqual(extractMiniMaxBaseResp(body), { code: 1002, message: 'rate limit' });
	});

	test('extracts the refusal from an SSE transcript, preferring it over earlier ok chunks', () => {
		const sse = [
			'data: {"choices":[{"delta":{"content":"hi"}}],"base_resp":{"status_code":0,"status_msg":""}}',
			'data: {"choices":[],"base_resp":{"status_code":1039,"status_msg":"token limit"}}',
			'data: [DONE]',
			'',
		].join('\n');

		assert.deepStrictEqual(readMiniMaxRefusal(sse), { code: 1039, message: 'token limit', kind: 'quota', ambiguous: false });
	});

	test('a truncated trailing chunk does not hide an earlier refusal', () => {
		// We only keep a bounded tail of a long stream, so the last line is routinely half a JSON.
		const sse = [
			'data: {"base_resp":{"status_code":1041,"status_msg":"conn limit"}}',
			'data: {"choices":[{"delta":{"content":"par',
		].join('\n');

		assert.deepStrictEqual(readMiniMaxRefusal(sse), { code: 1041, message: 'conn limit', kind: 'rate-limit', ambiguous: false });
	});

	test('healthy stream and unrelated bodies report no refusal', () => {
		const healthy = 'data: {"choices":[{"delta":{"content":"ok"}}],"base_resp":{"status_code":0,"status_msg":""}}';
		assert.deepStrictEqual(readMiniMaxRefusal(healthy)?.kind, 'ok');
		assert.strictEqual(extractMiniMaxBaseResp('data: {"choices":[]}'), undefined);
		assert.strictEqual(extractMiniMaxBaseResp(''), undefined);
		assert.strictEqual(extractMiniMaxBaseResp(undefined), undefined);
	});

	test('a non-numeric status_code is not trusted', () => {
		assert.strictEqual(extractMiniMaxBaseResp('{"base_resp":{"status_code":"1002"}}'), undefined);
	});
});
