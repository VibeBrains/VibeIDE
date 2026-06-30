/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	checkNpmCliAlignment,
	renderAlignmentReport,
} from '../../common/npmCliAlignmentCheck.js';

suite('npm scripts ↔ CLI alignment check (1137)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('checkNpmCliAlignment', () => {
		test('empty scripts → empty report', () => {
			const r = checkNpmCliAlignment({});
			assert.strictEqual(r.checked, 0);
			assert.deepStrictEqual(r.aligned, []);
			assert.deepStrictEqual(r.violations, []);
		});

		test('non-vibe scripts ignored', () => {
			const r = checkNpmCliAlignment({
				'build': 'tsc',
				'test': 'mocha',
			});
			assert.strictEqual(r.checked, 0);
		});

		test('aligned vibe:foo passes', () => {
			const r = checkNpmCliAlignment({
				'vibe:doctor': 'node scripts/vibe.js doctor',
				'vibe:skills:validate': 'node scripts/vibe.js skills validate',
			});
			assert.strictEqual(r.checked, 2);
			assert.strictEqual(r.aligned.length, 2);
			assert.strictEqual(r.violations.length, 0);
		});

		test('relative path ./scripts/vibe.js also aligned', () => {
			const r = checkNpmCliAlignment({
				'vibe:doctor': 'node ./scripts/vibe.js doctor',
			});
			assert.strictEqual(r.violations.length, 0);
		});

		test('does-not-call-vibe-js flagged', () => {
			const r = checkNpmCliAlignment({
				'vibe:doctor': 'node scripts/some-other.js doctor',
			});
			assert.strictEqual(r.violations.length, 1);
			assert.strictEqual(r.violations[0].reason, 'does-not-call-vibe-js');
		});

		test('extra post-pipe logic flagged', () => {
			const r = checkNpmCliAlignment({
				'vibe:doctor': 'node scripts/vibe.js doctor && echo done',
			});
			assert.strictEqual(r.violations.length, 1);
			assert.strictEqual(r.violations[0].reason, 'has-extra-post-pipe-logic');
		});

		test('empty body → not-a-vibe-script', () => {
			const r = checkNpmCliAlignment({ 'vibe:foo': '' });
			assert.strictEqual(r.violations.length, 1);
			assert.strictEqual(r.violations[0].reason, 'not-a-vibe-script');
		});

		test('whitespace-only body → not-a-vibe-script', () => {
			const r = checkNpmCliAlignment({ 'vibe:foo': '   ' });
			assert.strictEqual(r.violations.length, 1);
		});

		test('mixed input — partial pass', () => {
			const r = checkNpmCliAlignment({
				'vibe:doctor': 'node scripts/vibe.js doctor',                  // aligned
				'vibe:bad': 'node scripts/some-other.js x',                    // does-not-call
				'vibe:also-bad': 'node scripts/vibe.js x && rm -rf /',         // has-extra-post
				'build': 'tsc',                                                // not vibe:*, ignored
			});
			assert.strictEqual(r.checked, 3);
			assert.strictEqual(r.aligned.length, 1);
			assert.strictEqual(r.violations.length, 2);
		});
	});

	suite('renderAlignmentReport', () => {
		test('PASS heading when no violations', () => {
			const md = renderAlignmentReport(checkNpmCliAlignment({
				'vibe:doctor': 'node scripts/vibe.js doctor',
			}));
			assert.match(md, /alignment — PASS/);
		});

		test('FAIL heading + violations list', () => {
			const md = renderAlignmentReport(checkNpmCliAlignment({
				'vibe:bad': 'node scripts/some-other.js x',
			}));
			assert.match(md, /alignment — FAIL/);
			assert.match(md, /Violations/);
			assert.match(md, /vibe:bad/);
		});
	});
});
