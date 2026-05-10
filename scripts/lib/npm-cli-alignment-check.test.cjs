/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Self-test for the CJS port of npmCliAlignmentCheck. Mirrors a subset of the
// TS module's tests; the .ts file's full suite remains canonical.

'use strict';

const assert = require('node:assert');
const { checkNpmCliAlignment, renderAlignmentReport } = require('./npm-cli-alignment-check.cjs');

let passed = 0;
let failed = 0;

function test(name, fn) {
	try {
		fn();
		console.log(`ok - ${name}`);
		passed++;
	} catch (e) {
		console.log(`fail - ${name}`);
		console.log(`  ${e && e.message ? e.message : e}`);
		if (e && e.stack) console.log(e.stack);
		failed++;
	}
}

test('aligns canonical vibe:foo script', () => {
	const r = checkNpmCliAlignment({ 'vibe:foo': 'node scripts/vibe.js foo' });
	assert.strictEqual(r.checked, 1);
	assert.strictEqual(r.aligned.length, 1);
	assert.strictEqual(r.violations.length, 0);
});

test('accepts ./scripts/vibe.js path form', () => {
	const r = checkNpmCliAlignment({ 'vibe:bar': 'node ./scripts/vibe.js bar baz' });
	assert.strictEqual(r.aligned[0], 'vibe:bar');
	assert.strictEqual(r.violations.length, 0);
});

test('flags has-extra-pre-pipe-logic', () => {
	const r = checkNpmCliAlignment({ 'vibe:foo': 'tsc && node scripts/vibe.js foo' });
	assert.strictEqual(r.violations.length, 1);
	assert.strictEqual(r.violations[0].reason, 'has-extra-pre-pipe-logic');
});

test('flags has-extra-post-pipe-logic', () => {
	const r = checkNpmCliAlignment({ 'vibe:foo': 'node scripts/vibe.js foo && echo done' });
	assert.strictEqual(r.violations.length, 1);
	assert.strictEqual(r.violations[0].reason, 'has-extra-post-pipe-logic');
});

test('flags does-not-call-vibe-js', () => {
	const r = checkNpmCliAlignment({ 'vibe:foo': 'node scripts/some-other.js foo' });
	assert.strictEqual(r.violations.length, 1);
	assert.strictEqual(r.violations[0].reason, 'does-not-call-vibe-js');
});

test('flags empty / blank body as not-a-vibe-script', () => {
	const r = checkNpmCliAlignment({ 'vibe:empty': '   ' });
	assert.strictEqual(r.violations.length, 1);
	assert.strictEqual(r.violations[0].reason, 'not-a-vibe-script');
});

test('ignores non-vibe scripts', () => {
	const r = checkNpmCliAlignment({
		'test': 'node test.js',
		'build': 'tsc',
		'vibe:doctor': 'node scripts/vibe.js doctor',
	});
	assert.strictEqual(r.checked, 1);
	assert.strictEqual(r.aligned.length, 1);
});

test('renderAlignmentReport: PASS header when 0 violations', () => {
	const md = renderAlignmentReport({ checked: 1, aligned: ['vibe:doctor'], violations: [] });
	assert.match(md, /alignment — PASS/);
	assert.match(md, /1 `vibe:\*` scripts/);
});

test('renderAlignmentReport: FAIL header lists each violation', () => {
	const md = renderAlignmentReport({
		checked: 2,
		aligned: ['vibe:doctor'],
		violations: [
			{ scriptName: 'vibe:bad', scriptBody: 'tsc && node scripts/vibe.js bad', reason: 'has-extra-pre-pipe-logic' },
		],
	});
	assert.match(md, /alignment — FAIL/);
	assert.match(md, /vibe:bad/);
	assert.match(md, /has-extra-pre-pipe-logic/);
});

test('empty scripts → 0 checked, no violations', () => {
	const r = checkNpmCliAlignment({});
	assert.strictEqual(r.checked, 0);
	assert.strictEqual(r.violations.length, 0);
});

if (failed > 0) {
	console.error(`\n${failed} failed, ${passed} passed`);
	process.exit(1);
}
console.log(`\n${passed} passed`);
