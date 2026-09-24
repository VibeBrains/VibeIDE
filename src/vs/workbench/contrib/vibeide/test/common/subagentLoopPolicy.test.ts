/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decideStop, estimateTokensFromChars, hopTokenCost, truncateSummary, summaryTail, RESULT_SUMMARY_MAX_CHARS, chatModeForAllowedTools, collectPathsFromRawParams, buildExploreReport, buildSubagentTaskMessage } from '../../common/subagentLoopPolicy.js';

const LIMITS = { maxSteps: 5, maxTokensEst: 1000, deadlineAtMs: 10_000, maxDeniedActions: 3 };
const OK_STATE = { stepsDone: 1, tokensUsedEst: 100, deniedActions: 0, nowMs: 5000, cancelled: false };

suite('subagentLoopPolicy — headless tool-loop decisions (Phase 3b)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('decideStop: continue in bounds; each limit trips its reason; 0 = unlimited for deadline/tokens', () => {
		assert.deepStrictEqual(
			[
				decideStop(OK_STATE, LIMITS),
				decideStop({ ...OK_STATE, stepsDone: 5 }, LIMITS),
				decideStop({ ...OK_STATE, nowMs: 10_000 }, LIMITS),
				decideStop({ ...OK_STATE, tokensUsedEst: 1000 }, LIMITS),
				decideStop({ ...OK_STATE, deniedActions: 3 }, LIMITS),
				decideStop({ ...OK_STATE, nowMs: 999_999, tokensUsedEst: 999_999 }, { ...LIMITS, deadlineAtMs: 0, maxTokensEst: 0 }),
				decideStop({ ...OK_STATE, cancelled: true }, LIMITS),
			],
			[undefined, 'max-steps', 'deadline', 'token-budget', 'denied-actions', undefined, 'cancelled'],
		);
	});

	test('chatModeForAllowedTools: read-only whitelist → gather; any approval tool → agent', () => {
		assert.deepStrictEqual(
			[
				chatModeForAllowedTools(['read_file', 'ls_dir', 'grep', 'glob', 'search_for_files']),
				chatModeForAllowedTools(['read_file', 'edit_file']),
				chatModeForAllowedTools(['read_file', 'run_command']),
			],
			['gather', 'agent', 'agent'],
		);
	});

	test('helpers: token estimate, summary truncation, path collection, explore report, task message', () => {
		const report = buildExploreReport(['a.ts', 'a.ts', 'b.ts'], false);
		const truncatedReport = buildExploreReport([], true);
		const msg = buildSubagentTaskMessage({ displayName: 'Ревьюер', systemAppendix: 'Только чтение.', goal: 'Проверь дифф', contextItems: ['src/x.ts'] });
		assert.deepStrictEqual(
			[
				estimateTokensFromChars(10),
				truncateSummary('x'.repeat(600), 500).length,
				collectPathsFromRawParams({ uri: '/a b/c.ts', pageNumber: 1, path: '' }),
				[report.paths, report.confidence, report.truncated],
				[truncatedReport.confidence, truncatedReport.truncationSuggestion],
				[msg.includes('Ревьюер'), msg.includes('Проверь дифф'), msg.includes('src/x.ts'), msg.includes('vibe_complete')],
			],
			[
				3,
				500,
				['/a b/c.ts'],
				[['a.ts', 'b.ts'], 0.7, false],
				[0.35, 'retry'],
				[true, true, true, true],
			],
		);
	});

	/** A reviewer ends with its verdict: the part a head cut used to throw away. */
	test('a role answer travels as its end, and a diff rides as a block after the context', () => {
		const review = `${'замечание. '.repeat(400)}\nВЕРДИКТ: доработать`;
		const tail = summaryTail(review, RESULT_SUMMARY_MAX_CHARS);
		const msg = buildSubagentTaskMessage({ displayName: 'Критик', systemAppendix: '', goal: 'Сведи замечания', contextItems: ['src/x.ts'], diff: 'Дифф прогона:\n```diff\n+x\n```' });
		assert.deepStrictEqual({
			length: tail.length,
			keepsVerdict: tail.endsWith('ВЕРДИКТ: доработать'),
			marksCut: tail.startsWith('…'),
			short: summaryTail('  коротко  ', 10),
			diffAfterContext: msg.indexOf('Дифф прогона:') > msg.indexOf('src/x.ts') && msg.indexOf('Дифф прогона:') < msg.indexOf('vibe_complete'),
		}, { length: RESULT_SUMMARY_MAX_CHARS, keepsVerdict: true, marksCut: true, short: 'коротко', diffAfterContext: true });
	});

	test('hopTokenCost: real usage charges uncached input + output; excludes cache hits; falls back to char estimate', () => {
		assert.deepStrictEqual(
			[
				// usage present: (promptTokens - cachedInputTokens) + completionTokens
				hopTokenCost({ promptTokens: 7480, completionTokens: 110, cachedInputTokens: 128 }, 99999),
				// no cache field → full prompt + completion
				hopTokenCost({ promptTokens: 1000, completionTokens: 50 }, 99999),
				// cache hit never drives the charge below zero
				hopTokenCost({ promptTokens: 100, completionTokens: 0, cachedInputTokens: 500 }, 99999),
				// usage absent → char estimate fallback (chars/4)
				hopTokenCost(undefined, 40),
			],
			[7462, 1050, 0, 10],
		);
	});
});
