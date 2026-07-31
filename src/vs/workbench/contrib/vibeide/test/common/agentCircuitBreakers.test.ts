/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	BREAKER_CONFIGS, BreakerSnapshot, describeBreaker, initialBreaker, isBreakerBlocking,
	recoverBreaker, tripBreaker,
} from '../../common/agentCircuitBreakers.js';

const NOW = 1_000_000;

function trip(snapshot: BreakerSnapshot, times: number, reason = 'причина'): BreakerSnapshot {
	let current = snapshot;
	for (let i = 0; i < times; i++) {
		current = tripBreaker(current, BREAKER_CONFIGS[current.id], NOW + i, reason);
	}
	return current;
}

suite('agentCircuitBreakers — accumulate, open, and refuse to forget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a security breaker latches on the very first trip, skipping "open" entirely', () => {
		const secret = trip(initialBreaker('secret-leak'), 1, 'секрет в src/.env');
		assert.deepStrictEqual(
			[secret.state, secret.trips, isBreakerBlocking(secret), secret.reason],
			['latched', 1, true, 'секрет в src/.env'],
		);
	});

	test('a non-security breaker counts below its threshold and opens exactly at it', () => {
		const one = trip(initialBreaker('provider-errors'), 1);
		const two = trip(initialBreaker('provider-errors'), 2);
		const three = trip(initialBreaker('provider-errors'), 3);

		assert.deepStrictEqual(
			[[one.state, one.trips], [two.state, two.trips], [three.state, three.trips]],
			[['closed', 1], ['closed', 2], ['open', 3]],
		);
	});

	test('automatic recovery is bounded, then the breaker latches instead of looping', () => {
		let breaker = trip(initialBreaker('provider-errors'), 3);
		const config = BREAKER_CONFIGS['provider-errors'];

		const first = recoverBreaker(breaker, config, false);
		breaker = trip(first.snapshot, 3);
		const second = recoverBreaker(breaker, config, false);
		breaker = trip(second.snapshot, 3);
		const third = recoverBreaker(breaker, config, false);

		assert.deepStrictEqual(
			[
				[first.recovered, first.snapshot.state, first.snapshot.autoRecoveries],
				[second.recovered, second.snapshot.state, second.snapshot.autoRecoveries],
				[third.recovered, third.snapshot.state, third.refusal],
			],
			[
				[true, 'closed', 1],
				[true, 'closed', 2],
				[false, 'latched', 'auto-limit-reached'],
			],
		);
	});

	test('a security breaker refuses automatic recovery outright — only a human closes it', () => {
		const latched = trip(initialBreaker('protected-path'), 1);
		const auto = recoverBreaker(latched, BREAKER_CONFIGS['protected-path'], false);
		const manual = recoverBreaker(latched, BREAKER_CONFIGS['protected-path'], true);

		assert.deepStrictEqual(
			[
				[auto.recovered, auto.refusal, auto.snapshot.state],
				[manual.recovered, manual.snapshot.state, manual.snapshot.trips, manual.snapshot.autoRecoveries],
			],
			[
				[false, 'latched', 'latched'],
				[true, 'closed', 0, 0],
			],
		);
	});

	test('further trips on a latched breaker keep the original cause', () => {
		const latched = trip(initialBreaker('secret-leak'), 1, 'первая причина');
		const again = tripBreaker(latched, BREAKER_CONFIGS['secret-leak'], NOW + 500, 'вторая причина');

		assert.deepStrictEqual(
			[again.state, again.trips, again.reason, again.lastTrippedAt],
			['latched', 2, 'первая причина', NOW + 500],
		);
	});

	test('description states what it takes to resume, not just that something broke', () => {
		assert.deepStrictEqual(
			[
				describeBreaker(initialBreaker('role-budget')),
				describeBreaker(trip(initialBreaker('secret-leak'), 1, 'ключ в .env')),
				describeBreaker(trip(initialBreaker('provider-errors'), 3, 'таймаут')),
			],
			[
				'в норме',
				'остановлено, снимается только вручную — ключ в .env',
				'остановлено, восстановится автоматически — таймаут',
			],
		);
	});
});
