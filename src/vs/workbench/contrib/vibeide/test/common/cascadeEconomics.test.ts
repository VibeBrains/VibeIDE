/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { cascadeEconomics, ModelRate } from '../../common/cascadeEconomics.js';
import { AgentRunRecord } from '../../common/agentRunLedger.js';

/**
 * Окупается ли каскад.
 *
 * The arithmetic decides whether a feature stays on, so the tests pin the two ways it could lie:
 * counting an escalation as a replacement for its draft rather than an addition to it, and printing
 * a confident «$0.00 saved» when no price was known.
 */
suite('cascade economics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const run = (over: Partial<AgentRunRecord>): AgentRunRecord => ({
		runId: 'r', epoch: 'e', fence: 0 as never, role: 'coder', goal: 'g', parentThreadId: 't',
		status: 'succeeded' as never, startedAt: 0, ...over,
	});

	const cheap: ModelRate = { input: 0.1, output: 0.4 };
	const strong: ModelRate = { input: 1.5, output: 6.0 };
	const rateOf = (provider: string | undefined, model: string | undefined): ModelRate | undefined =>
		model === 'strong' ? strong : model === 'cheap' ? cheap : undefined;

	const draft = (tokensUsed: number, id = 'd') => run({ runId: id, cascadeDraft: true, provider: 'p', model: 'cheap', tokensUsed });
	const escalation = (tokensUsed: number, from = 'd') => run({ runId: `${from}-esc`, escalatedFromRunId: from, escalatedFromModel: 'p/cheap', provider: 'p', model: 'strong', tokensUsed });

	test('the share counts escalations against attempts, not against all runs', () => {
		const economics = cascadeEconomics([
			draft(1000, 'a'), draft(1000, 'b'), draft(1000, 'c'), draft(1000, 'd'),
			escalation(1000, 'a'),
			// An ordinary run is neither: including it would flatter the share.
			run({ runId: 'plain', provider: 'p', model: 'strong', tokensUsed: 5000 }),
		], rateOf);
		assert.deepStrictEqual(
			[economics.attempts, economics.escalations, economics.escalationShare],
			[4, 1, 0.25],
		);
	});

	/**
	 * The whole point: a draft that gets escalated is money spent twice. If the comparison treated
	 * the escalation as replacing the draft, a cascade would look free and could never lose.
	 */
	test('an escalation is paid on top of its draft', () => {
		// One escalation among four attempts: three drafts stood on their own, one was thrown away.
		const economics = cascadeEconomics([
			draft(1_000_000, 'a'), draft(1_000_000, 'b'), draft(1_000_000, 'c'), draft(1_000_000, 'd'),
			escalation(1_000_000, 'a'),
		], rateOf);
		// Blended rates: cheap ≈ 0.145/M, strong ≈ 2.175/M. The cascade pays four drafts and one
		// escalation; strong-only would have paid its own rate for all four tasks.
		assert.ok(economics.spentUsd! > 2.7 && economics.spentUsd! < 2.8, `spent=${economics.spentUsd}`);
		assert.ok(economics.strongOnlyUsd! > 8.6 && economics.strongOnlyUsd! < 8.8, `strongOnly=${economics.strongOnlyUsd}`);
		assert.ok(economics.deltaUsd! < 0, 'при одной эскалации из четырёх каскад дешевле');
	});

	/**
	 * The counterfactual must not be charged for the draft it never needed: doing so would inflate
	 * the rival and make every cascade look profitable, including the ones that are not.
	 */
	test('escalating every attempt is a pure loss', () => {
		const economics = cascadeEconomics([draft(1_000_000), escalation(1_000_000)], rateOf);
		assert.strictEqual(economics.escalationShare, 1);
		assert.ok(economics.deltaUsd! > 0, `черновик выброшен целиком: delta=${economics.deltaUsd}`);
	});

	/** «Сэкономлено $0.00» там, где цена неизвестна, — это ложь, а не ноль. */
	test('an unknown price leaves the money columns empty rather than zero', () => {
		const economics = cascadeEconomics([draft(1000), escalation(1000)], () => undefined);
		assert.deepStrictEqual(
			[economics.spentUsd, economics.strongOnlyUsd, economics.deltaUsd, economics.escalations],
			[undefined, undefined, undefined, 1],
		);
	});

	test('no cascade steps means nothing to report', () => {
		const economics = cascadeEconomics([run({ provider: 'p', model: 'strong', tokensUsed: 100 })], rateOf);
		assert.deepStrictEqual(
			[economics.attempts, economics.escalations, economics.escalationShare],
			[0, 0, undefined],
		);
	});

	/** Break-even is what makes the share actionable: 8% of the strong rate leaves ~92% headroom. */
	test('the break-even share follows the price gap', () => {
		const economics = cascadeEconomics([draft(1000), escalation(1000)], rateOf);
		assert.ok(economics.breakEvenShare! > 0.9 && economics.breakEvenShare! < 0.95, `порог=${economics.breakEvenShare}`);
	});
});
