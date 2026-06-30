/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	formatInlineAiExplanation,
	truncateInline,
	formatRelativeTime,
	InlineAiExplanationInput,
} from '../../common/inlineAiExplanationFormatter.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const NOW = 1_700_000_000_000;

const fixt = (overrides: Partial<InlineAiExplanationInput> = {}): InlineAiExplanationInput => ({
	session: {
		sessionId: 'abcdef0123456789',
		modelId: 'claude-3-5-sonnet',
		promptSummary: 'rewrite auth middleware to use new constraints',
		timestampMs: NOW - 60_000,
	},
	planStep: {
		planId: 'p-001',
		stepIdx: 2,
		stepTitle: 'Replace JSON.parse with safeParseConfigJson',
	},
	rationale: {
		toolName: 'edit_file',
		rationale: 'replacing the throwing parse with a banner-on-corrupt envelope so the service stays up',
	},
	writeRange: {
		filePathBasename: 'vibeConstraintsService.ts',
		startLine: 170,
		endLine: 215,
	},
	...overrides,
});

suite('inlineAiExplanationFormatter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('truncateInline', () => {
		test('short string passes through', () => {
			assert.strictEqual(truncateInline('hello', 10), 'hello');
		});

		test('exact length passes through', () => {
			assert.strictEqual(truncateInline('hello', 5), 'hello');
		});

		test('overflow gets ellipsis', () => {
			assert.strictEqual(truncateInline('hello world', 8), 'hello w…');
		});

		test('budget ≤ ellipsis length → just ellipsis', () => {
			assert.strictEqual(truncateInline('hello', 1), '…');
		});

		test('non-string returns empty', () => {
			assert.strictEqual(truncateInline(null as unknown as string, 10), '');
		});
	});

	suite('formatRelativeTime', () => {
		test('seconds', () => {
			assert.strictEqual(formatRelativeTime(15_000), '15с назад');
		});

		test('minutes', () => {
			assert.strictEqual(formatRelativeTime(5 * 60_000), '5м назад');
		});

		test('hours', () => {
			assert.strictEqual(formatRelativeTime(3 * 3_600_000), '3ч назад');
		});

		test('days', () => {
			assert.strictEqual(formatRelativeTime(2 * 86_400_000), '2д назад');
		});

		test('clock skew (negative) clamps to "только что"', () => {
			assert.strictEqual(formatRelativeTime(-1_000), 'только что');
		});

		test('NaN clamps to "только что"', () => {
			assert.strictEqual(formatRelativeTime(NaN), 'только что');
		});
	});

	suite('formatInlineAiExplanation', () => {
		test('full content fits → no truncation', () => {
			const r = formatInlineAiExplanation(fixt(), NOW);
			assert.strictEqual(r.truncated, false);
			assert.strictEqual(r.skippedSections.length, 0);
			assert.match(r.markdown, /vibeConstraintsService\.ts:170-215/);
			assert.match(r.markdown, /Session abcdef01/);
			assert.match(r.markdown, /claude-3-5-sonnet/);
			assert.match(r.markdown, /Plan \*\*p-001\*\* step 3/);
			assert.match(r.markdown, /edit_file/);
		});

		test('omitting rationale renders without tool block', () => {
			const r = formatInlineAiExplanation(fixt({ rationale: undefined }), NOW);
			assert.ok(!r.markdown.includes('Tool:'));
		});

		test('omitting plan step renders without plan block', () => {
			const r = formatInlineAiExplanation(fixt({ planStep: undefined }), NOW);
			assert.ok(!r.markdown.includes('Plan'));
		});

		test('omitting prompt summary keeps session line but no quote', () => {
			// Drop rationale too: the only blockquote ("> ") that could appear is then
			// the prompt-summary quote, so its absence proves the summary was omitted.
			const r = formatInlineAiExplanation(fixt({
				session: {
					sessionId: 'abc',
					modelId: 'm',
					timestampMs: NOW - 60_000,
				},
				rationale: undefined,
			}), NOW);
			assert.ok(r.markdown.includes('Session abc'));
			assert.ok(!r.markdown.includes('> '));
		});

		test('truncation drops rationale quote first', () => {
			const r = formatInlineAiExplanation(fixt(), NOW);
			// Force a budget that fits everything except rationale quote
			const tight = formatInlineAiExplanation(fixt(), NOW);
			// Re-run with a very tight budget that requires step 1 truncation
			const long = formatInlineAiExplanation({
				...fixt(),
				rationale: {
					toolName: 'edit_file',
					rationale: 'x'.repeat(500),
				},
				maxChars: 250,
			}, NOW);
			assert.ok(long.truncated);
			assert.ok(long.skippedSections.includes('rationale'));
			// Tool name still present, quote dropped
			assert.match(long.markdown, /edit_file/);
			assert.ok(!long.markdown.includes('xxx'));
			// silence unused
			void r; void tight;
		});

		test('tighter budget drops session summary as second step', () => {
			const r = formatInlineAiExplanation({
				...fixt(),
				session: { ...fixt().session, promptSummary: 'y'.repeat(200) },
				rationale: { toolName: 'edit_file', rationale: 'x'.repeat(400) },
				maxChars: 200,
			}, NOW);
			assert.ok(r.skippedSections.includes('rationale'));
			assert.ok(r.skippedSections.includes('session-summary'));
			assert.ok(!r.markdown.includes('y'.repeat(50)));
		});

		test('extreme tight budget drops plan step too', () => {
			const r = formatInlineAiExplanation({
				...fixt(),
				maxChars: 80,
			}, NOW);
			// All three drop categories present in skipped
			assert.ok(r.skippedSections.includes('rationale'));
			assert.ok(r.skippedSections.includes('session-summary'));
			assert.ok(r.skippedSections.includes('plan-step'));
		});

		test('hard cut applied if still over budget after all section drops', () => {
			const r = formatInlineAiExplanation({
				session: { sessionId: '0123456789abcdef0123456789abcdef', timestampMs: NOW, modelId: 'really-long-model-name-that-fills-budget' },
				writeRange: { filePathBasename: 'a-very-long-filename-that-fills-budget.ts', startLine: 1, endLine: 99999 },
				maxChars: 50,
			}, NOW);
			// Either fits exactly under budget, or hard-truncated to budget
			assert.ok(r.markdown.length <= 50);
			assert.ok(r.truncated);
		});

		test('relative time shown in header', () => {
			const r = formatInlineAiExplanation(fixt({
				session: { ...fixt().session, timestampMs: NOW - 5 * 60_000 },
			}), NOW);
			assert.match(r.markdown, /5м назад/);
		});

		test('session id rendered as 8-char prefix', () => {
			const r = formatInlineAiExplanation(fixt(), NOW);
			assert.match(r.markdown, /Session abcdef01/);
			assert.ok(!r.markdown.includes('abcdef0123456789'));
		});

		test('default maxChars is 600 (no truncation under typical input)', () => {
			const r = formatInlineAiExplanation(fixt(), NOW);
			assert.ok(r.markdown.length <= 600);
			assert.strictEqual(r.truncated, false);
		});
	});
});
