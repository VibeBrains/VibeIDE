/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { compressCommandOutput, compressGenericToolOutput, detectCommandKind } from '../../common/commandOutputCompressor.js';

const lines = (...ls: string[]) => ls.join('\n');
const seq = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));

suite('commandOutputCompressor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('detectCommandKind', () => {
		test('recognises families, prefixes and delegation', () => {
			assert.deepStrictEqual(
				[
					detectCommandKind('git status'),
					detectCommandKind('$ git push origin main'),
					detectCommandKind('FOO=bar sudo docker build .'),
					detectCommandKind('npm test'),
					detectCommandKind('pnpm run test:unit'),
					detectCommandKind('cargo test'),
					detectCommandKind('cargo build'),
					detectCommandKind('ls -la'),
					detectCommandKind('echo hello'),
					detectCommandKind(''),
				],
				['git', 'git', 'docker', 'test', 'test', 'test', 'unknown', 'ls', 'unknown', 'unknown'],
			);
		});
	});

	test('empty input passes through both entry points', () => {
		assert.strictEqual(compressCommandOutput('git status', '', true), '');
		assert.strictEqual(compressGenericToolOutput(''), '');
	});

	test('git profile collapses a long file listing, keeps conflicts', () => {
		const input = lines(
			'On branch next',
			'Changes not staged for commit:',
			...seq(40, i => `\tmodified:   src/file_${i}.ts`),
			'\tboth modified:   src/conflicted.ts',
		);
		const out = compressCommandOutput('git status', input, true);
		assert.ok(out.includes('file entries]'), `expected file-run marker in:\n${out}`);
		assert.ok(out.includes('both modified:   src/conflicted.ts'), 'conflict line must survive');
		assert.ok(out.length < input.length * 0.9, 'expected meaningful shrink');
	});

	test('test profile drops passing tests, keeps failures and summary', () => {
		const input = lines(
			...seq(40, i => `  ✓ renders component ${i}`),
			'  ✗ handles error state',
			'    Error: expected true to be false',
			'Tests: 1 failed, 40 passed, 41 total',
		);
		const out = compressCommandOutput('npm test', input, true);
		assert.ok(out.includes('passing tests]'), `expected passing-run marker in:\n${out}`);
		assert.ok(out.includes('✗ handles error state'), 'failure line must survive');
		assert.ok(out.includes('Tests: 1 failed, 40 passed, 41 total'), 'summary must survive');
		assert.ok(!out.includes('renders component 20'), 'middle passing test dropped');
	});

	test('profiles disabled falls back to generic pass (no profile markers)', () => {
		const input = lines(...seq(40, i => `  ✓ renders component ${i}`), 'Tests: 40 passed');
		const out = compressCommandOutput('npm test', input, false);
		assert.ok(!out.includes('passing tests]'), 'no profile marker when profiles are off');
	});

	test('generic tool output dedups identical spam lines', () => {
		const input = lines(...seq(90, () => 'DEBUG connection retry'));
		const out = compressGenericToolOutput(input);
		assert.ok(out.length < input.length, 'expected generic dedup to shrink repeated output');
	});
});
