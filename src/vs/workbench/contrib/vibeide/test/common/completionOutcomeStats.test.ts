/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	aggregateCompletionEvents,
	CompletionEvent,
} from '../../common/completionOutcomeStats.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const event = (overrides: Partial<CompletionEvent>): CompletionEvent => ({
	timestamp: NOW,
	modelId: 'qwen2.5-coder:7b',
	outcome: 'accept',
	suggestionLength: 50,
	...overrides,
});

suite('Completion outcome stats (1024)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('aggregateCompletionEvents', () => {
		test('empty input → zero totals', () => {
			const r = aggregateCompletionEvents([], NOW - DAY, NOW);
			assert.strictEqual(r.totalEvents, 0);
			assert.strictEqual(r.overallAcceptRate, 0);
			assert.deepStrictEqual(r.rows, []);
		});

		test('counts accepts / rejects / ignores per model', () => {
			const r = aggregateCompletionEvents([
				event({ outcome: 'accept' }),
				event({ outcome: 'accept' }),
				event({ outcome: 'reject' }),
				event({ outcome: 'ignore' }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.rows.length, 1);
			const row = r.rows[0];
			assert.strictEqual(row.accepts, 2);
			assert.strictEqual(row.rejects, 1);
			assert.strictEqual(row.ignores, 1);
			assert.strictEqual(Math.round(row.acceptRate * 100) / 100, 0.5);
		});

		test('sorts by acceptRate desc, totalEvents desc, modelId asc tiebreak', () => {
			const r = aggregateCompletionEvents([
				// modelA: 1/2 accept rate
				event({ modelId: 'modelA', outcome: 'accept' }),
				event({ modelId: 'modelA', outcome: 'reject' }),
				// modelB: 2/2 accept rate
				event({ modelId: 'modelB', outcome: 'accept' }),
				event({ modelId: 'modelB', outcome: 'accept' }),
				// modelC: 1/1 accept rate (ties with B on rate, fewer events)
				event({ modelId: 'modelC', outcome: 'accept' }),
			], NOW - DAY, NOW);
			assert.deepStrictEqual(r.rows.map(r => r.modelId), ['modelB', 'modelC', 'modelA']);
		});

		test('drops out-of-range events', () => {
			const r = aggregateCompletionEvents([
				event({ timestamp: NOW - 2 * DAY }),
				event({ timestamp: NOW - DAY / 2 }),
				event({ timestamp: NOW + DAY }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.totalEvents, 1);
		});

		test('drops malformed events', () => {
			const events: unknown[] = [
				event({}),
				{ timestamp: NOW, modelId: '', outcome: 'accept', suggestionLength: 10 },
				{ timestamp: NOW, modelId: 'm', outcome: 'unknown', suggestionLength: 10 },
				{ timestamp: NaN, modelId: 'm', outcome: 'accept', suggestionLength: 10 },
				{ timestamp: NOW, modelId: 'm', outcome: 'accept', suggestionLength: -1 },
			];
			const r = aggregateCompletionEvents(events as CompletionEvent[], NOW - DAY, NOW);
			assert.strictEqual(r.totalEvents, 1);
		});

		test('avgLatencyMs is null when no event reported latency', () => {
			const r = aggregateCompletionEvents([event({})], NOW - DAY, NOW);
			assert.strictEqual(r.rows[0].avgLatencyMs, null);
		});

		test('avgLatencyMs averages reported values', () => {
			const r = aggregateCompletionEvents([
				event({ latencyMs: 100 }),
				event({ latencyMs: 200 }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.rows[0].avgLatencyMs, 150);
		});

		test('keepRate computed from acceptedLength / suggestionLength', () => {
			const r = aggregateCompletionEvents([
				event({ outcome: 'accept', suggestionLength: 100, acceptedLength: 50 }),
				event({ outcome: 'accept', suggestionLength: 100, acceptedLength: 100 }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.rows[0].keepRate, 0.75); // 150 / 200
		});

		test('keepRate null when no accepted events recorded length', () => {
			const r = aggregateCompletionEvents([
				event({ outcome: 'accept', suggestionLength: 100 }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.rows[0].keepRate, null);
		});

		test('overallAcceptRate aggregates across models', () => {
			const r = aggregateCompletionEvents([
				event({ modelId: 'a', outcome: 'accept' }),
				event({ modelId: 'b', outcome: 'reject' }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.overallAcceptRate, 0.5);
		});

		test('boundary timestamps inclusive', () => {
			const r = aggregateCompletionEvents([
				event({ timestamp: NOW - DAY }),
				event({ timestamp: NOW }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.totalEvents, 2);
		});
	});
});
