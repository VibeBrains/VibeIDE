/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	aggregatePerfGuardrails,
	renderGuardrailDashboardMarkdown,
	GuardrailTripEvent,
} from '../../common/perfGuardrailsAggregator.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const event = (overrides: Partial<GuardrailTripEvent>): GuardrailTripEvent => ({
	timestamp: NOW,
	rule: 'chunk-gap',
	observedValue: 100,
	thresholdValue: 50,
	...overrides,
});

suite('Perf guardrails aggregator (1059)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('aggregatePerfGuardrails', () => {
		test('empty input → zero totals', () => {
			const r = aggregatePerfGuardrails([], NOW - DAY, NOW);
			assert.strictEqual(r.totalTrips, 0);
			assert.deepStrictEqual(r.rules, []);
		});

		test('counts trips per rule', () => {
			const r = aggregatePerfGuardrails([
				event({ rule: 'chunk-gap' }),
				event({ rule: 'chunk-gap' }),
				event({ rule: 'main-thread-block' }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.totalTrips, 3);
			assert.strictEqual(r.rules.length, 2);
			assert.strictEqual(r.rules[0].rule, 'chunk-gap');
			assert.strictEqual(r.rules[0].tripCount, 2);
		});

		test('records max + avg observed values', () => {
			const r = aggregatePerfGuardrails([
				event({ observedValue: 50 }),
				event({ observedValue: 200 }),
				event({ observedValue: 150 }),
			], NOW - DAY, NOW);
			const row = r.rules[0];
			assert.strictEqual(row.maxObservedValue, 200);
			assert.strictEqual(Math.round(row.avgObservedValue), 133);
		});

		test('takes most-recent threshold when it shifts', () => {
			const r = aggregatePerfGuardrails([
				event({ timestamp: NOW - 1000, thresholdValue: 50 }),
				event({ timestamp: NOW, thresholdValue: 100 }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.rules[0].thresholdValue, 100);
		});

		test('drops out-of-range events', () => {
			const r = aggregatePerfGuardrails([
				event({ timestamp: NOW - 2 * DAY }),
				event({ timestamp: NOW - DAY / 2 }),
				event({ timestamp: NOW + DAY }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.totalTrips, 1);
		});

		test('drops malformed events', () => {
			const events: unknown[] = [
				event({}),
				{ /* missing fields */ },
				{ ...event({}), rule: 'unknown-rule' },
				{ ...event({}), observedValue: NaN },
			];
			const r = aggregatePerfGuardrails(events as GuardrailTripEvent[], NOW - DAY, NOW);
			assert.strictEqual(r.totalTrips, 1);
		});

		test('sorts rules by tripCount desc + name asc tiebreak', () => {
			const r = aggregatePerfGuardrails([
				event({ rule: 'chunk-gap' }),
				event({ rule: 'main-thread-block' }),
				event({ rule: 'main-thread-block' }),
				event({ rule: 'memory-delta' }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.rules[0].rule, 'main-thread-block');
			assert.strictEqual(r.rules[1].rule, 'chunk-gap');
			assert.strictEqual(r.rules[2].rule, 'memory-delta');
		});

		test('picks the most-frequent context as topContext', () => {
			const r = aggregatePerfGuardrails([
				event({ context: 'apply-edit' }),
				event({ context: 'apply-edit' }),
				event({ context: 'tool-call' }),
			], NOW - DAY, NOW);
			const row = r.rules[0];
			assert.strictEqual(row.topContext, 'apply-edit');
			assert.strictEqual(row.topContextCount, 2);
		});

		test('topContext alphabetical tiebreak', () => {
			const r = aggregatePerfGuardrails([
				event({ context: 'b' }),
				event({ context: 'a' }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.rules[0].topContext, 'a');
		});

		test('events without context → topContext empty', () => {
			const r = aggregatePerfGuardrails([event({})], NOW - DAY, NOW);
			assert.strictEqual(r.rules[0].topContext, '');
		});
	});

	suite('renderGuardrailDashboardMarkdown', () => {
		test('empty dashboard → "No guardrail trips" line', () => {
			const d = aggregatePerfGuardrails([], NOW - DAY, NOW);
			const md = renderGuardrailDashboardMarkdown(d);
			assert.match(md, /No guardrail trips/);
		});

		test('renders rule lines + topContext', () => {
			const d = aggregatePerfGuardrails([event({ context: 'apply-edit' })], NOW - DAY, NOW);
			const md = renderGuardrailDashboardMarkdown(d);
			assert.match(md, /chunk-gap/);
			assert.match(md, /apply-edit/);
		});

		test('header line includes period in days + total trips', () => {
			const d = aggregatePerfGuardrails([event({})], NOW - DAY, NOW);
			const md = renderGuardrailDashboardMarkdown(d);
			assert.match(md, /Period: \d+ day\(s\) — 1 guardrail trips/);
		});
	});
});
