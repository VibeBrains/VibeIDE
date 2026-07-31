/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	DEFAULT_ENABLED_CHECKS, TurnCheckId, TurnFacts, decideTurnChecks, evaluateTurnChecks, renderTurnChecksCorrective,
} from '../../common/agentTurnChecks.js';

const ALL_CHECKS: readonly TurnCheckId[] = ['no-secret-leak', 'no-protected-path', 'forbidden-action', 'budget-exceeded', 'source-location'];

function facts(overrides: Partial<TurnFacts> = {}): TurnFacts {
	return {
		changedFiles: ['src/app.ts'],
		secretHits: [],
		protectedHits: [],
		forbiddenTools: [],
		tokensUsed: 1_000,
		tokenQuota: 100_000,
		citations: [],
		...overrides,
	};
}

function failedIds(input: TurnFacts, enabled: readonly TurnCheckId[] = ALL_CHECKS): string[] {
	return evaluateTurnChecks(input, enabled).filter(r => !r.passed).map(r => r.id);
}

suite('agentTurnChecks — deterministic checks on what a turn did', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a clean turn passes every check, and each check still reports itself', () => {
		const results = evaluateTurnChecks(facts(), ALL_CHECKS);
		assert.deepStrictEqual(
			[results.length, results.every(r => r.passed), failedIds(facts())],
			[5, true, []],
		);
	});

	test('each check fails on its own kind of evidence', () => {
		assert.deepStrictEqual(
			[
				failedIds(facts({ secretHits: [{ file: '.env', kind: 'aws-key' }] })),
				failedIds(facts({ protectedHits: [{ file: 'dist/app.js', pattern: 'dist/**' }] })),
				failedIds(facts({ forbiddenTools: ['run_command'] })),
				failedIds(facts({ tokensUsed: 200_000 })),
				failedIds(facts({ citations: [{ path: 'src/app.ts', line: 999, exists: false }] })),
			],
			[
				['no-secret-leak'],
				['no-protected-path'],
				['forbidden-action'],
				['budget-exceeded'],
				['source-location'],
			],
		);
	});

	test('budget cannot fail without a quota; a satisfied citation does not fail', () => {
		assert.deepStrictEqual(
			[
				failedIds(facts({ tokenQuota: 0, tokensUsed: 10_000_000 })),
				failedIds(facts({ citations: [{ path: 'src/app.ts', line: 12, exists: true }] })),
			],
			[[], []],
		);
	});

	test('only enabled checks run — the default pair protects data and nothing else', () => {
		const noisy = facts({ forbiddenTools: ['run_command'], tokensUsed: 200_000, secretHits: [{ file: '.env', kind: 'token' }] });
		assert.deepStrictEqual(
			[
				evaluateTurnChecks(noisy, DEFAULT_ENABLED_CHECKS).map(r => r.id),
				failedIds(noisy, DEFAULT_ENABLED_CHECKS),
			],
			[
				['no-secret-leak', 'no-protected-path'],
				['no-secret-leak'],
			],
		);
	});

	test('decision mirrors the other gates: notify never blocks, enforce bounces then stops', () => {
		const failures = evaluateTurnChecks(facts({ secretHits: [{ file: '.env', kind: 'token' }] }), ['no-secret-leak']).filter(r => !r.passed);
		assert.deepStrictEqual(
			[
				decideTurnChecks({ mode: 'off', failures, attemptsUsed: 0, maxAttempts: 2 }),
				decideTurnChecks({ mode: 'enforce', failures: [], attemptsUsed: 0, maxAttempts: 2 }),
				decideTurnChecks({ mode: 'notify', failures, attemptsUsed: 0, maxAttempts: 2 }),
				decideTurnChecks({ mode: 'enforce', failures, attemptsUsed: 0, maxAttempts: 2 }),
				decideTurnChecks({ mode: 'enforce', failures, attemptsUsed: 2, maxAttempts: 2 }),
			],
			['complete', 'complete', 'notify-complete', 'bounce', 'stop'],
		);
	});

	test('corrective names the failures and the attempt', () => {
		const failures = evaluateTurnChecks(facts({ protectedHits: [{ file: 'dist/a.js', pattern: 'dist/**' }] }), ['no-protected-path']).filter(r => !r.passed);
		const text = renderTurnChecksCorrective(failures, 1, 2);
		assert.deepStrictEqual(
			[text.includes('dist/a.js'), text.includes('dist/**'), text.includes('попытка 1 из 2')],
			[true, true, true],
		);
	});
});
