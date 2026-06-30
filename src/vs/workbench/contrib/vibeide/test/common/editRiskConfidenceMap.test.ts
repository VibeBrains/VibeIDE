/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	deriveConfidenceColor,
	isAutoBlockedByConfidence,
	auditPolicyConsistency,
} from '../../common/editRiskConfidenceMap.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Edit risk → confidence mapping (1057)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('deriveConfidenceColor', () => {
		test('low risk + safe judge → green', () => {
			assert.strictEqual(deriveConfidenceColor({ riskScore: 0.1, llmJudge: 'safe' }), 'green');
		});

		test('low risk without judge → green', () => {
			assert.strictEqual(deriveConfidenceColor({ riskScore: 0.1 }), 'green');
		});

		test('mid risk → yellow', () => {
			assert.strictEqual(deriveConfidenceColor({ riskScore: 0.5 }), 'yellow');
		});

		test('low risk + unknown judge → yellow', () => {
			assert.strictEqual(deriveConfidenceColor({ riskScore: 0.1, llmJudge: 'unknown' }), 'yellow');
		});

		test('high risk → red', () => {
			assert.strictEqual(deriveConfidenceColor({ riskScore: 0.9 }), 'red');
		});

		test('judge risky → red regardless of low score', () => {
			assert.strictEqual(deriveConfidenceColor({ riskScore: 0.1, llmJudge: 'risky' }), 'red');
		});

		test('heuristic flag forces red regardless of judge=safe', () => {
			assert.strictEqual(
				deriveConfidenceColor({ riskScore: 0.0, llmJudge: 'safe', heuristicFlags: ['auth'] }),
				'red',
			);
		});

		test('judge=safe does NOT upgrade high risk to green', () => {
			// Per AGENTS.md: judge cannot upgrade.
			assert.strictEqual(deriveConfidenceColor({ riskScore: 0.95, llmJudge: 'safe' }), 'red');
		});

		test('out-of-range score is clamped (negative → 0 → green path)', () => {
			assert.strictEqual(deriveConfidenceColor({ riskScore: -2 }), 'green');
		});

		test('out-of-range score is clamped (10 → 1 → red)', () => {
			assert.strictEqual(deriveConfidenceColor({ riskScore: 10 }), 'red');
		});

		test('NaN score treated as 0', () => {
			assert.strictEqual(deriveConfidenceColor({ riskScore: NaN }), 'green');
		});

		test('boundary 0.8 is yellow (>0.4 path), 0.81 is red', () => {
			assert.strictEqual(deriveConfidenceColor({ riskScore: 0.8 }), 'yellow');
			assert.strictEqual(deriveConfidenceColor({ riskScore: 0.81 }), 'red');
		});
	});

	suite('isAutoBlockedByConfidence', () => {
		test('green-eligible input is not blocked', () => {
			assert.deepStrictEqual(isAutoBlockedByConfidence({ riskScore: 0.0, llmJudge: 'safe' }), { blocked: false });
		});

		test('high risk is blocked with reason risk-high', () => {
			assert.deepStrictEqual(isAutoBlockedByConfidence({ riskScore: 0.9 }), { blocked: true, reason: 'risk-high' });
		});

		test('judge risky is blocked with reason judge-risky', () => {
			assert.deepStrictEqual(
				isAutoBlockedByConfidence({ riskScore: 0.1, llmJudge: 'risky' }),
				{ blocked: true, reason: 'judge-risky' },
			);
		});

		test('heuristic flag is blocked with reason heuristic-flag', () => {
			assert.deepStrictEqual(
				isAutoBlockedByConfidence({ riskScore: 0.0, heuristicFlags: ['delete'] }),
				{ blocked: true, reason: 'heuristic-flag' },
			);
		});

		test('heuristic-flag wins precedence over risk-high', () => {
			assert.deepStrictEqual(
				isAutoBlockedByConfidence({ riskScore: 0.95, heuristicFlags: ['env'] }),
				{ blocked: true, reason: 'heuristic-flag' },
			);
		});
	});

	suite('auditPolicyConsistency', () => {
		test('returns null when all samples are consistent', () => {
			const samples = [
				{ riskScore: 0.9 },
				{ riskScore: 0.0, llmJudge: 'risky' as const },
				{ riskScore: 0.0, heuristicFlags: ['auth'] as const },
				{ riskScore: 0.0 },
			];
			assert.strictEqual(auditPolicyConsistency(samples), null);
		});
	});
});
