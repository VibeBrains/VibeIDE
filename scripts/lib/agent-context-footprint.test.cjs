#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Self-contained smoke tests for scripts/lib/agent-context-footprint.cjs.
// Run: `node scripts/lib/agent-context-footprint.test.cjs`. No deps.

const assert = require('node:assert/strict');
const {
	WINDOW_TOKENS,
	WARN_SHARE,
	estimateTokens,
	summariseContextFootprint,
	describeContextFootprint,
} = require('./agent-context-footprint.cjs');

let passed = 0;
function test(name, fn) {
	fn();
	passed += 1;
	console.log(`  ok  ${name}`);
}

test('a small footprint is reported without a warning', () => {
	const report = summariseContextFootprint([
		{ category: 'rules', path: '.vibe/rules/a.md', chars: 1000 },
		{ category: 'manuals', path: 'docs/manuals/b.md', chars: 1500 },
	]);
	assert.deepEqual(
		{ tokens: report.tokens, categories: report.categories.map(c => [c.category, c.files, c.tokens]), level: describeContextFootprint(report).level },
		{ tokens: estimateTokens(2500), categories: [['rules', 1, 400], ['manuals', 1, 600]], level: 'ok' },
	);
});

test('crossing the share threshold warns and names the largest file', () => {
	// Just over the warn share, all of it in one manual.
	const chars = Math.ceil(WINDOW_TOKENS * WARN_SHARE * 2.5) + 100;
	const report = summariseContextFootprint([
		{ category: 'manuals', path: 'docs/manuals/big.md', chars },
		{ category: 'manuals', path: 'docs/manuals/small.md', chars: 10 },
	]);
	const described = describeContextFootprint(report);
	assert.equal(described.level, 'warning');
	assert.match(described.message, /docs\/manuals\/big\.md/);
});

test('unknown categories are kept, not silently dropped from the total', () => {
	const report = summariseContextFootprint([
		{ category: 'rules', path: 'r', chars: 250 },
		{ category: 'мемуары', path: 'm', chars: 250 },
	]);
	assert.deepEqual(
		{ total: report.tokens, names: report.categories.map(c => c.category) },
		{ total: 200, names: ['rules', 'мемуары'] },
	);
});

test('nothing measured means nothing said', () => {
	assert.equal(describeContextFootprint(summariseContextFootprint([])), null);
});

console.log(`\n${passed} passed`);
