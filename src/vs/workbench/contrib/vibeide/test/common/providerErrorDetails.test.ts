/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeProviderRefusal } from '../../common/providerErrorDetails.js';

suite('providerErrorDetails — what the provider reported, in the error card', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the MiniMax case: HTTP 200 with a refusal in the body still produces the body code', () => {
		const rows = describeProviderRefusal({
			httpStatus: 200,
			bodyCode: 1008,
			bodyMessage: 'insufficient balance',
			refusalKind: 'quota',
			observedAt: 1,
		});

		assert.deepStrictEqual(
			rows.map(row => [row.label, row.value]),
			[
				['HTTP-статус', '200'],
				['Код в теле ответа', '1008'],
				['Сообщение провайдера', 'insufficient balance'],
				['Классификация', 'quota'],
			],
		);
	});

	test('an ambiguous verdict says so — the vendor docs conflicting is itself the finding', () => {
		const [row] = describeProviderRefusal({ refusalKind: 'rateLimit', refusalAmbiguous: true, observedAt: 1 });
		assert.strictEqual(row.value, 'rateLimit (по документации вендора трактуется неоднозначно)');
	});

	test('the observed rate is spelled out per minute — a guess becomes a comparable number', () => {
		const rows = describeProviderRefusal({ requestsInWindow: 15, windowSeconds: 120, observedAt: 1 });
		assert.deepStrictEqual(rows.map(r => r.value), ['15 за 120 с ≈ 7.5 в минуту']);
	});

	test('only rate-limit headers survive — the rest is noise in a card this size', () => {
		const rows = describeProviderRefusal({
			headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'retry-after': '30' },
			observedAt: 1,
		});
		assert.deepStrictEqual(rows.map(r => r.value), ['retry-after: 30\nx-ratelimit-remaining: 0']);
	});

	test('nothing known produces no rows — an empty row would claim we asked and got nothing', () => {
		assert.deepStrictEqual([describeProviderRefusal(undefined).length, describeProviderRefusal({ observedAt: 1 }).length], [0, 0]);
	});
});
