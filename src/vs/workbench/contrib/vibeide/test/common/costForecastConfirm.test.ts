/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decideCostConfirm,
	describeCostDecision,
	CostForecast,
	COST_FORECAST_DEFAULTS,
} from '../../common/costForecastConfirm.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const fc = (overrides: Partial<CostForecast>): CostForecast => ({
	provider: 'anthropic',
	modelId: 'claude-sonnet-4-6',
	estimatedUSD: 0.1,
	estimatedTokens: 5_000,
	...overrides,
});

suite('Cost forecast confirm (926)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideCostConfirm', () => {
		test('under both thresholds → auto-allow', () => {
			const r = decideCostConfirm(fc({}));
			assert.deepStrictEqual(r, { kind: 'auto-allow', reason: 'under-thresholds' });
		});

		test('over USD threshold → require-confirm(over-usd)', () => {
			const r = decideCostConfirm(fc({ estimatedUSD: 1.0 }));
			assert.deepStrictEqual(r, { kind: 'require-confirm', reason: 'over-usd' });
		});

		test('over token threshold → require-confirm(over-tokens)', () => {
			const r = decideCostConfirm(fc({ estimatedTokens: 100_000 }));
			assert.deepStrictEqual(r, { kind: 'require-confirm', reason: 'over-tokens' });
		});

		test('alwaysConfirm overrides everything', () => {
			const r = decideCostConfirm(fc({}), { ...COST_FORECAST_DEFAULTS, alwaysConfirm: true });
			assert.deepStrictEqual(r, { kind: 'require-confirm', reason: 'always-confirm' });
		});

		test('alwaysConfirm wins even with session approval', () => {
			const r = decideCostConfirm(fc({ estimatedUSD: 0.1 }), {
				...COST_FORECAST_DEFAULTS,
				alwaysConfirm: true,
				sessionApprovals: [{ provider: 'anthropic', modelId: 'claude-sonnet-4-6', approvedUpToUSD: 10 }],
			});
			assert.deepStrictEqual(r, { kind: 'require-confirm', reason: 'always-confirm' });
		});

		test('session approval skips confirm under cap', () => {
			const r = decideCostConfirm(fc({ estimatedUSD: 1.0 }), {
				...COST_FORECAST_DEFAULTS,
				sessionApprovals: [{ provider: 'anthropic', modelId: 'claude-sonnet-4-6', approvedUpToUSD: 2.0 }],
			});
			assert.deepStrictEqual(r, { kind: 'auto-allow', reason: 'session-approved' });
		});

		test('session approval ignored when current cost exceeds cap', () => {
			const r = decideCostConfirm(fc({ estimatedUSD: 5.0 }), {
				...COST_FORECAST_DEFAULTS,
				sessionApprovals: [{ provider: 'anthropic', modelId: 'claude-sonnet-4-6', approvedUpToUSD: 2.0 }],
			});
			assert.strictEqual(r.kind, 'require-confirm');
		});

		test('session approval ignored for different model', () => {
			const r = decideCostConfirm(fc({ estimatedUSD: 1.0 }), {
				...COST_FORECAST_DEFAULTS,
				sessionApprovals: [{ provider: 'anthropic', modelId: 'claude-haiku', approvedUpToUSD: 2.0 }],
			});
			assert.strictEqual(r.kind, 'require-confirm');
		});

		test('USD threshold takes precedence over token threshold (priority order)', () => {
			const r = decideCostConfirm(fc({ estimatedUSD: 1.0, estimatedTokens: 100_000 }));
			assert.strictEqual((r as { reason: string }).reason, 'over-usd');
		});
	});

	suite('describeCostDecision', () => {
		test('auto-allow → empty string', () => {
			const f = fc({});
			const d = decideCostConfirm(f);
			assert.strictEqual(describeCostDecision(f, d), '');
		});

		test('over-usd message includes price + tokens + provider/model', () => {
			const f = fc({ estimatedUSD: 1.234, estimatedTokens: 1234 });
			const d = decideCostConfirm(f);
			const text = describeCostDecision(f, d);
			assert.match(text, /\$1\.23/);
			assert.match(text, /1,234/);
			assert.match(text, /anthropic\/claude-sonnet-4-6/);
		});

		test('always-confirm message format', () => {
			const f = fc({});
			const d = decideCostConfirm(f, { ...COST_FORECAST_DEFAULTS, alwaysConfirm: true });
			const text = describeCostDecision(f, d);
			assert.match(text, /always/i);
		});
	});
});
