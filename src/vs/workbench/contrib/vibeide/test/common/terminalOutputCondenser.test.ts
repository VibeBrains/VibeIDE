/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { condenseTerminalOutput } from '../../common/terminalOutputCondenser.js';

const lines = (...ls: string[]) => ls.join('\n');
const repeat = (line: string, n: number) => Array.from({ length: n }, () => line);

// Pad helpers: the condenser only fires on outputs >= 80 lines, with protected
// head (15) and tail (25). Build outputs as [head pad] + middle + [tail pad].
const HEAD_PAD = repeat('header line: setup', 16);
const TAIL_PAD = repeat('footer line: teardown', 26);
const build = (middle: string[]) => lines(...HEAD_PAD, ...middle, ...TAIL_PAD);

suite('terminalOutputCondenser', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('short output passes through untouched', () => {
		const input = lines(...repeat('test foo ... ok', 30));
		assert.strictEqual(condenseTerminalOutput(input), input);
	});

	test('empty input passes through', () => {
		assert.strictEqual(condenseTerminalOutput(''), '');
	});

	test('collapses runs of identical lines with [× N]', () => {
		const input = build(repeat('warning: unused variable `x`', 50));
		const out = condenseTerminalOutput(input);
		assert.ok(out.includes('warning: unused variable `x` [× 50]'), `expected dup marker in:\n${out}`);
		assert.ok(out.length < input.length * 0.7, 'expected meaningful shrink');
	});

	test('collapses cargo-test pass spam, keeps head of run', () => {
		const middle = Array.from({ length: 60 }, (_, i) => `test module_${i}::works ... ok`);
		const input = build(middle);
		const out = condenseTerminalOutput(input);
		assert.ok(out.includes('test module_0::works ... ok'), 'first noise lines kept');
		assert.ok(out.includes('similar lines condensed]'), `expected noise marker in:\n${out}`);
		assert.ok(!out.includes('test module_30::works'), 'middle of noise run dropped');
	});

	test('error lines and their context survive inside a noise run', () => {
		const middle = [
			...Array.from({ length: 30 }, (_, i) => `test a_${i} ... ok`),
			'test b_fails ... FAILED',
			'assertion failed: left == right',
			...Array.from({ length: 30 }, (_, i) => `test c_${i} ... ok`),
		];
		const out = condenseTerminalOutput(build(middle));
		assert.ok(out.includes('test b_fails ... FAILED'), 'failure line kept');
		assert.ok(out.includes('assertion failed: left == right'), 'assertion detail kept');
	});

	test('summary lines are kept verbatim', () => {
		const middle = [
			...Array.from({ length: 50 }, (_, i) => `✓ case ${i} passes`),
			'48 passing (2s)',
			'2 failing',
		];
		const out = condenseTerminalOutput(build(middle));
		assert.ok(out.includes('48 passing (2s)'), 'passing summary kept');
		assert.ok(out.includes('2 failing'), 'failing summary kept');
	});

	test('head and tail of output are never collapsed', () => {
		const input = build(repeat('Downloading crates.io index chunk', 40));
		const out = condenseTerminalOutput(input);
		// every head pad line still present
		assert.strictEqual(out.split('\n').filter(l => l === 'header line: setup').length, HEAD_PAD.length);
		assert.strictEqual(out.split('\n').filter(l => l === 'footer line: teardown').length, TAIL_PAD.length);
	});

	test('heterogeneous meaningful output is left alone (no markers)', () => {
		// 90 distinct non-noise lines — nothing recognisable to collapse.
		const middle = Array.from({ length: 90 }, (_, i) => `step ${i}: copied src/file_${i}.ts to out/file_${i}.js`);
		const input = lines(...middle);
		const out = condenseTerminalOutput(input);
		assert.strictEqual(out, input);
	});

	test('progress-bar spam collapses', () => {
		const middle = Array.from({ length: 40 }, (_, i) => `[${'='.repeat(Math.min(20, i))}>${' '.repeat(Math.max(0, 20 - i))}] ${i * 2}/80`);
		const out = condenseTerminalOutput(build(middle));
		assert.ok(out.includes('similar lines condensed]'), `expected progress collapse in:\n${out}`);
	});
});
