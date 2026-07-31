/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const assert = require('node:assert');
const { aggregatePerfGuardrails, renderGuardrailDashboardMarkdown } = require('./perf-guardrails-aggregator.cjs');

let passed = 0, failed = 0;
function test(name, fn) {
	try { fn(); console.log(`ok - ${name}`); passed++; }
	catch (e) { console.log(`fail - ${name}\n  ${e.message}`); failed++; }
}

test('empty events → 0 trips, no rules', () => {
	const d = aggregatePerfGuardrails([], 0, 1000);
	assert.strictEqual(d.totalTrips, 0);
	assert.strictEqual(d.rules.length, 0);
});

test('aggregates trips by rule with sort by count desc', () => {
	const events = [
		{ rule: 'chunk-gap', timestamp: 100, observedValue: 5, thresholdValue: 4 },
		{ rule: 'chunk-gap', timestamp: 200, observedValue: 6, thresholdValue: 4 },
		{ rule: 'fps-drop', timestamp: 300, observedValue: 25, thresholdValue: 30 },
	];
	const d = aggregatePerfGuardrails(events, 0, 1000);
	assert.strictEqual(d.totalTrips, 3);
	assert.strictEqual(d.rules[0].rule, 'chunk-gap');
	assert.strictEqual(d.rules[0].tripCount, 2);
	assert.strictEqual(d.rules[0].maxObservedValue, 6);
	assert.strictEqual(d.rules[0].avgObservedValue, 5.5);
});

test('drops out-of-window + malformed events', () => {
	const events = [
		{ rule: 'chunk-gap', timestamp: 50, observedValue: 5, thresholdValue: 4 },   // out
		{ rule: 'chunk-gap', timestamp: 100, observedValue: 5, thresholdValue: 4 },  // in
		{ rule: 'unknown-rule', timestamp: 150, observedValue: 5, thresholdValue: 4 },// malformed
		null,                                                                          // malformed
		{ rule: 'chunk-gap', timestamp: 9999, observedValue: 5, thresholdValue: 4 }, // out
	];
	const d = aggregatePerfGuardrails(events, 80, 200);
	assert.strictEqual(d.totalTrips, 1);
});

test('topContext picks most frequent', () => {
	const events = [
		{ rule: 'chunk-gap', timestamp: 100, observedValue: 5, thresholdValue: 4, context: 'A' },
		{ rule: 'chunk-gap', timestamp: 110, observedValue: 5, thresholdValue: 4, context: 'B' },
		{ rule: 'chunk-gap', timestamp: 120, observedValue: 5, thresholdValue: 4, context: 'A' },
	];
	const d = aggregatePerfGuardrails(events, 0, 1000);
	assert.strictEqual(d.rules[0].topContext, 'A');
	assert.strictEqual(d.rules[0].topContextCount, 2);
});

test('renderGuardrailDashboardMarkdown: empty has _No trips_ line', () => {
	const md = renderGuardrailDashboardMarkdown({ periodStart: 0, periodEnd: 1000, totalTrips: 0, rules: [] });
	assert.match(md, /_No guardrail trips/);
});

test('renderGuardrailDashboardMarkdown: rules render as table rows', () => {
	const md = renderGuardrailDashboardMarkdown({
		periodStart: 0, periodEnd: 1000, totalTrips: 2,
		rules: [{ rule: 'chunk-gap', tripCount: 2, maxObservedValue: 6, avgObservedValue: 5.5, thresholdValue: 4, topContext: 'render', topContextCount: 2 }],
	});
	assert.match(md, /chunk-gap/);
	assert.match(md, /\| 2 \|/);
});

if (failed > 0) { console.error(`\n${failed} failed, ${passed} passed`); process.exit(1); }
console.log(`\n${passed} passed`);
