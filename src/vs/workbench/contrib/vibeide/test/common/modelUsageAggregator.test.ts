/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	aggregateModelUsage,
	renderUsageMarkdown,
	ModelUsageEvent,
} from '../../common/modelUsageAggregator.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const event = (overrides: Partial<ModelUsageEvent>): ModelUsageEvent => ({
	timestamp: NOW,
	provider: 'anthropic',
	modelId: 'claude-sonnet-4-6',
	kind: 'chat',
	inputTokens: 100,
	outputTokens: 50,
	...overrides,
});

suite('Model usage aggregator (1183)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('aggregateModelUsage', () => {
		test('empty input → zero totals', () => {
			const r = aggregateModelUsage([], NOW - DAY, NOW);
			assert.strictEqual(r.totalEvents, 0);
			assert.strictEqual(r.totalTokens, 0);
			assert.deepStrictEqual(r.byProvider, []);
		});

		test('aggregates per provider with model sub-totals', () => {
			const r = aggregateModelUsage([
				event({ inputTokens: 100, outputTokens: 50 }),
				event({ inputTokens: 200, outputTokens: 100 }),
				event({ provider: 'ollama', modelId: 'qwen2.5-coder:7b', inputTokens: 10, outputTokens: 5 }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.totalEvents, 3);
			assert.strictEqual(r.totalInputTokens, 310);
			assert.strictEqual(r.totalOutputTokens, 155);
			assert.strictEqual(r.byProvider.length, 2);
			// Anthropic has 450 tokens, Ollama 15 → anthropic first.
			assert.strictEqual(r.byProvider[0].provider, 'anthropic');
			assert.strictEqual(r.byProvider[1].provider, 'ollama');
		});

		test('drops events outside the period', () => {
			const r = aggregateModelUsage([
				event({ timestamp: NOW - 2 * DAY }),
				event({ timestamp: NOW - DAY / 2 }),
				event({ timestamp: NOW + DAY }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.totalEvents, 1);
		});

		test('counts kinds correctly', () => {
			const r = aggregateModelUsage([
				event({ kind: 'chat' }),
				event({ kind: 'chat' }),
				event({ kind: 'completion' }),
				event({ kind: 'apply' }),
				event({ kind: 'plan' }),
				event({ kind: 'mcp' }),
			], NOW - DAY, NOW);
			assert.deepStrictEqual(r.byKind, { chat: 2, completion: 1, apply: 1, plan: 1, mcp: 1 });
		});

		test('drops malformed events', () => {
			const events: unknown[] = [
				event({}),
				{ /* missing fields */ },
				{ ...event({}), inputTokens: -1 },
				{ ...event({}), kind: 'unknown' },
				{ ...event({}), timestamp: 'not-a-number' },
			];
			const r = aggregateModelUsage(events as ModelUsageEvent[], NOW - DAY, NOW);
			assert.strictEqual(r.totalEvents, 1);
		});

		test('boundary timestamps are inclusive', () => {
			const r = aggregateModelUsage([
				event({ timestamp: NOW - DAY }),
				event({ timestamp: NOW }),
			], NOW - DAY, NOW);
			assert.strictEqual(r.totalEvents, 2);
		});

		test('models within provider sorted by totalTokens desc, name asc tiebreak', () => {
			const r = aggregateModelUsage([
				event({ modelId: 'claude-haiku', inputTokens: 100, outputTokens: 50 }),
				event({ modelId: 'claude-opus', inputTokens: 1000, outputTokens: 500 }),
				event({ modelId: 'claude-sonnet', inputTokens: 100, outputTokens: 50 }),
			], NOW - DAY, NOW);
			const models = r.byProvider[0].models;
			assert.strictEqual(models[0].modelId, 'claude-opus');
			// haiku and sonnet both have 150 tokens → name ascending
			assert.strictEqual(models[1].modelId, 'claude-haiku');
			assert.strictEqual(models[2].modelId, 'claude-sonnet');
		});
	});

	suite('renderUsageMarkdown', () => {
		test('empty aggregation prints "no usage" line', () => {
			const agg = aggregateModelUsage([], NOW - DAY, NOW);
			const md = renderUsageMarkdown(agg);
			assert.ok(md.includes('VibeIDE — Model usage report'));
			assert.ok(md.includes('No usage in the selected period'));
		});

		test('renders provider section with model bullets', () => {
			const agg = aggregateModelUsage([
				event({ inputTokens: 1234, outputTokens: 567 }),
			], NOW - DAY, NOW);
			const md = renderUsageMarkdown(agg);
			assert.ok(md.includes('anthropic'));
			assert.ok(md.includes('claude-sonnet-4-6'));
			assert.ok(md.includes('1,801')); // formatted total
		});

		test('always includes period header line', () => {
			const agg = aggregateModelUsage([], NOW - DAY, NOW);
			const md = renderUsageMarkdown(agg);
			assert.match(md, /Period: \d+ day\(s\) — 0 events/);
		});
	});
});
