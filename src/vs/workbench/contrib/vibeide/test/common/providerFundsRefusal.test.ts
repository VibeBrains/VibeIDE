/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { detectNoFundsRefusal, noFundsStatusText } from '../../common/providerFundsRefusal.js';

suite('providerFundsRefusal — "out of money" is not "too fast"', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// Verbatim body from the live Z.AI refusal that started this (429, subscription key on the
	// pay-as-you-go endpoint).
	const ZAI_BODY = '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}';

	test('the Z.AI 429 is recognised as a funds refusal, with its vendor code', () => {
		assert.deepStrictEqual(detectNoFundsRefusal(429, ZAI_BODY), { isNoFunds: true, vendorCode: '1113' });
	});

	test('an ordinary rate limit stays a rate limit — otherwise we would stop retrying what retrying fixes', () => {
		const body = '{"error":{"message":"Rate limit reached for gpt-4o in organization org-x on requests per min"}}';
		assert.strictEqual(detectNoFundsRefusal(429, body).isNoFunds, false);
	});

	test('a monthly usage quota is NOT a funds refusal — it resets on its own', () => {
		const body = '{"error":{"message":"Monthly usage limit reached. Resets in 5 days."}}';
		assert.strictEqual(detectNoFundsRefusal(429, body).isNoFunds, false);
	});

	test('wording is recognised across statuses and without a code — vendors put this behind 429, 402 and 400', () => {
		assert.deepStrictEqual(
			[402, 400, 429].map(status => detectNoFundsRefusal(status, '{"message":"Insufficient credits, please recharge"}').isNoFunds),
			[true, true, true],
		);
	});

	test('a success or an empty body is never a funds refusal', () => {
		assert.deepStrictEqual(
			[detectNoFundsRefusal(200, ZAI_BODY).isNoFunds, detectNoFundsRefusal(429, undefined).isNoFunds, detectNoFundsRefusal(429, '').isNoFunds],
			[false, false, false],
		);
	});

	test('statusText stays ASCII — a non-Latin-1 character makes the Response constructor throw', () => {
		const text = noFundsStatusText({ isNoFunds: true, vendorCode: '1113' });
		assert.deepStrictEqual(
			[/^[\x20-\x7E]*$/.test(text), text.includes('1113'), new Response(null, { status: 402, statusText: text }).statusText === text],
			[true, true, true],
		);
	});
});
