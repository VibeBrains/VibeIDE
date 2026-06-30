/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	initFailoverState,
	processOutcome,
	FAILOVER_DEFAULTS,
	FailoverConfig,
} from '../../common/providerFailover.js';

const NOW = 1_000_000;

const cfg = (overrides: Partial<FailoverConfig> = {}): FailoverConfig => ({
	...FAILOVER_DEFAULTS,
	chain: ['anthropic', 'openai', 'ollama'],
	...overrides,
});

suite('Provider failover FSM (1187)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('processOutcome — success / 4xx / cancelled paths', () => {
		test('success with no prior failures → no-op', () => {
			const s = initFailoverState('anthropic');
			const r = processOutcome(s, 'success', NOW, cfg());
			assert.deepStrictEqual(r.decision, { kind: 'no-op' });
			assert.deepStrictEqual(r.state, s);
		});

		test('success after 2 failures resets count', () => {
			let s = initFailoverState('anthropic');
			s = processOutcome(s, 'timeout', NOW, cfg()).state;
			s = processOutcome(s, 'server-5xx', NOW, cfg()).state;
			assert.strictEqual(s.consecutiveFailures, 2);
			const r = processOutcome(s, 'success', NOW, cfg());
			assert.deepStrictEqual(r.decision, { kind: 'reset-failure-count' });
			assert.strictEqual(r.state.consecutiveFailures, 0);
		});

		test('client-4xx also resets count (not a provider outage)', () => {
			let s = initFailoverState('anthropic');
			s = processOutcome(s, 'timeout', NOW, cfg()).state;
			s = processOutcome(s, 'server-5xx', NOW, cfg()).state;
			const r = processOutcome(s, 'client-4xx', NOW, cfg());
			assert.deepStrictEqual(r.decision, { kind: 'reset-failure-count' });
		});

		test('cancelled is always a no-op', () => {
			let s = initFailoverState('anthropic');
			s = processOutcome(s, 'timeout', NOW, cfg()).state;
			const r = processOutcome(s, 'cancelled', NOW, cfg());
			assert.deepStrictEqual(r.decision, { kind: 'no-op' });
			assert.strictEqual(r.state.consecutiveFailures, 1); // unchanged
		});
	});

	suite('processOutcome — failure path & switch', () => {
		test('first 2 failures only increment count', () => {
			let s = initFailoverState('anthropic');
			let r = processOutcome(s, 'timeout', NOW, cfg());
			assert.deepStrictEqual(r.decision, { kind: 'increment-failure-count', newCount: 1 });
			s = r.state;
			r = processOutcome(s, 'server-5xx', NOW + 1, cfg());
			assert.deepStrictEqual(r.decision, { kind: 'increment-failure-count', newCount: 2 });
		});

		test('3rd failure switches to next provider', () => {
			let s = initFailoverState('anthropic');
			s = processOutcome(s, 'timeout', NOW, cfg()).state;
			s = processOutcome(s, 'timeout', NOW + 1, cfg()).state;
			const r = processOutcome(s, 'timeout', NOW + 2, cfg());
			assert.deepStrictEqual(r.decision, {
				kind: 'switch',
				from: 'anthropic',
				to: 'openai',
				reason: 'consecutive-failures',
			});
			assert.strictEqual(r.state.currentProviderId, 'openai');
			assert.strictEqual(r.state.consecutiveFailures, 0);
			assert.strictEqual(r.state.lastSwitchAt, NOW + 2);
		});

		test('cooldown after switch keeps incrementing instead of switching', () => {
			let s = initFailoverState('anthropic');
			// First chain: trigger switch
			s = processOutcome(s, 'timeout', NOW, cfg()).state;
			s = processOutcome(s, 'timeout', NOW, cfg()).state;
			s = processOutcome(s, 'timeout', NOW, cfg()).state; // → openai
			assert.strictEqual(s.currentProviderId, 'openai');
			// Within cooldown (default 30s), 3 more failures shouldn't advance to ollama.
			s = processOutcome(s, 'timeout', NOW + 5_000, cfg()).state;
			s = processOutcome(s, 'timeout', NOW + 10_000, cfg()).state;
			const r = processOutcome(s, 'timeout', NOW + 15_000, cfg());
			// Cooldown active → still incrementing, not switching.
			assert.strictEqual(r.decision.kind, 'increment-failure-count');
			assert.strictEqual(r.state.currentProviderId, 'openai');
		});

		test('chain exhaustion emits chain-exhausted', () => {
			const config = cfg({ switchCooldownMs: 0 });
			let s = initFailoverState('ollama'); // already last in chain
			s = processOutcome(s, 'timeout', NOW, config).state;
			s = processOutcome(s, 'timeout', NOW + 1, config).state;
			const r = processOutcome(s, 'timeout', NOW + 2, config);
			assert.deepStrictEqual(r.decision, { kind: 'chain-exhausted', lastTriedProviderId: 'ollama' });
			assert.strictEqual(r.state.currentProviderId, 'ollama');
		});

		test('current provider not in chain → switches to head', () => {
			const config = cfg({ chain: ['openai', 'ollama'] });
			let s = initFailoverState('anthropic'); // not in chain
			s = processOutcome(s, 'timeout', NOW, config).state;
			s = processOutcome(s, 'timeout', NOW + 1, config).state;
			const r = processOutcome(s, 'timeout', NOW + 2, config);
			assert.deepStrictEqual(r.decision, {
				kind: 'switch', from: 'anthropic', to: 'openai', reason: 'consecutive-failures',
			});
		});

		test('custom threshold honored', () => {
			let s = initFailoverState('anthropic');
			const config = cfg({ consecutiveFailureThreshold: 2 });
			s = processOutcome(s, 'timeout', NOW, config).state;
			const r = processOutcome(s, 'timeout', NOW + 1, config);
			assert.strictEqual(r.decision.kind, 'switch');
		});
	});

	suite('initFailoverState', () => {
		test('initializes with given provider and zero failures', () => {
			const s = initFailoverState('anthropic');
			assert.deepStrictEqual(s, {
				currentProviderId: 'anthropic',
				consecutiveFailures: 0,
				lastSwitchAt: null,
			});
		});
	});
});
