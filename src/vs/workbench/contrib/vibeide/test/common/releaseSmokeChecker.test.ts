/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	evaluateSmokeRun,
	renderSmokeSummary,
	describeSmokeFailure,
	SMOKE_DEFAULTS,
} from '../../common/releaseSmokeChecker.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const goodRun = {
	exitCode: 0,
	stdout: 'starting…\nVibeIDE ready\nshutting down\n',
	stderr: '',
	timeToReadyMs: 1500,
	durationMs: 3000,
};

suite('Release smoke checker (1163)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('evaluateSmokeRun', () => {
		test('happy path → pass with no failures', () => {
			const r = evaluateSmokeRun(goodRun);
			assert.strictEqual(r.pass, true);
			assert.strictEqual(r.failures.length, 0);
		});

		test('non-zero exit → failure recorded', () => {
			const r = evaluateSmokeRun({ ...goodRun, exitCode: 1 });
			assert.strictEqual(r.pass, false);
			assert.ok(r.failures.some(f => f.kind === 'non-zero-exit'));
		});

		test('missing welcome marker → failure recorded', () => {
			const r = evaluateSmokeRun({ ...goodRun, stdout: 'starting…' });
			assert.strictEqual(r.pass, false);
			assert.ok(r.failures.some(f => f.kind === 'no-welcome-marker'));
		});

		test('FATAL in stderr → failure recorded', () => {
			const r = evaluateSmokeRun({ ...goodRun, stderr: 'FATAL crash' });
			assert.strictEqual(r.pass, false);
			assert.ok(r.failures.some(f => f.kind === 'fatal-stderr'));
		});

		test('Uncaught in stderr → failure recorded', () => {
			const r = evaluateSmokeRun({ ...goodRun, stderr: 'Uncaught Error: something' });
			assert.strictEqual(r.pass, false);
		});

		test('too slow to ready → failure recorded', () => {
			const r = evaluateSmokeRun({ ...goodRun, timeToReadyMs: 100_000 });
			assert.strictEqual(r.pass, false);
			assert.ok(r.failures.some(f => f.kind === 'too-slow-to-ready'));
		});

		test('too slow overall → failure recorded', () => {
			const r = evaluateSmokeRun({ ...goodRun, durationMs: 100_000 });
			assert.strictEqual(r.pass, false);
			assert.ok(r.failures.some(f => f.kind === 'too-slow-overall'));
		});

		test('all-the-bad-things smoke run → all failures collected', () => {
			const r = evaluateSmokeRun({
				exitCode: 1,
				stdout: 'starting…',
				stderr: 'FATAL Uncaught',
				timeToReadyMs: 100_000,
				durationMs: 200_000,
			});
			assert.strictEqual(r.pass, false);
			assert.ok(r.failures.length >= 4);
		});

		test('custom config respected', () => {
			const r = evaluateSmokeRun(
				{ ...goodRun, stdout: 'CustomReady' },
				{ ...SMOKE_DEFAULTS, welcomeMarker: 'CustomReady' },
			);
			assert.strictEqual(r.pass, true);
		});
	});

	suite('describeSmokeFailure', () => {
		test('produces non-empty descriptions for every failure kind', () => {
			const samples = [
				describeSmokeFailure({ kind: 'non-zero-exit', exitCode: 7 }),
				describeSmokeFailure({ kind: 'no-welcome-marker' }),
				describeSmokeFailure({ kind: 'fatal-stderr', marker: 'FATAL' }),
				describeSmokeFailure({ kind: 'too-slow-to-ready', timeToReadyMs: 60_000, limitMs: 30_000 }),
				describeSmokeFailure({ kind: 'too-slow-overall', durationMs: 100_000, limitMs: 60_000 }),
			];
			for (const text of samples) {
				assert.ok(text.length > 0);
			}
		});
	});

	suite('renderSmokeSummary', () => {
		test('PASS in heading when all clear', () => {
			const md = renderSmokeSummary(goodRun, evaluateSmokeRun(goodRun));
			assert.match(md, /Release smoke — PASS/);
		});

		test('FAIL with bullet list when failures exist', () => {
			const bad = { ...goodRun, exitCode: 1, stdout: 'no marker', stderr: 'FATAL', timeToReadyMs: 100_000, durationMs: 200_000 };
			const md = renderSmokeSummary(bad, evaluateSmokeRun(bad));
			assert.match(md, /Release smoke — FAIL/);
			assert.match(md, /## Failures/);
		});

		test('includes byte counts and timings', () => {
			const md = renderSmokeSummary(goodRun, evaluateSmokeRun(goodRun));
			assert.match(md, /stdout bytes/);
			assert.match(md, /time to "ready"/);
		});
	});
});
