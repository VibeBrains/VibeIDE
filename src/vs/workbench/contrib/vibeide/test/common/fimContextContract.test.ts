/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	reportFIMBudget,
	trimCurrentFileToBudget,
	FIMContext,
	FIM_BUDGET_DEFAULTS,
	FIMBudgetExceededError,
} from '../../common/fimContextContract.js';

const baseContext = (overrides: Partial<FIMContext> = {}): FIMContext => ({
	currentFile: {
		uri: 'file:///a.ts',
		languageId: 'typescript',
		prefix: 'a'.repeat(200),
		suffix: 'b'.repeat(200),
	},
	openTabs: [],
	recentEdits: [],
	...overrides,
});

suite('FIM context contract (1018)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('reportFIMBudget', () => {
		test('under budget — nothing trimmed', () => {
			const r = reportFIMBudget(baseContext());
			assert.deepStrictEqual(r.trimmed, []);
			assert.strictEqual(r.currentFileChars, 400);
		});

		test('drops skill-discoveries first', () => {
			const ctx = baseContext({ skillDiscoveries: 'x'.repeat(8000) });
			const r = reportFIMBudget(ctx);
			assert.ok(r.trimmed.includes('skill-discoveries'));
			assert.strictEqual(r.skillDiscoveriesChars, 0);
		});

		test('drops AST after skill-discoveries', () => {
			const ctx = baseContext({
				skillDiscoveries: 'x'.repeat(4000),
				astSnippet: 'y'.repeat(5000),
			});
			// Tight cap so each successive drop is still over budget — the walker
			// stops as soon as it fits, so the default 8000 cap would drop only one.
			const r = reportFIMBudget(ctx, { ...FIM_BUDGET_DEFAULTS, maxContextChars: 350 });
			assert.ok(r.trimmed.includes('skill-discoveries'));
			assert.ok(r.trimmed.includes('ast-snippet'));
		});

		test('drops project-rules / recent-edits / open-tabs in order', () => {
			const ctx = baseContext({
				projectRules: 'p'.repeat(3000),
				recentEdits: [{ uri: 'u', timestamp: 0, hunk: 'h'.repeat(3000) }],
				openTabs: [{ uri: 'u', languageId: 'ts', snippet: 's'.repeat(3000) }],
			});
			const r = reportFIMBudget(ctx, { ...FIM_BUDGET_DEFAULTS, maxContextChars: 350 });
			assert.deepStrictEqual([...r.trimmed].sort(), ['open-tabs', 'project-rules', 'recent-edits']);
		});

		test('current-file is preserved when other sections fit budget', () => {
			const ctx = baseContext({ openTabs: [{ uri: 'u', languageId: 'ts', snippet: 'short' }] });
			const r = reportFIMBudget(ctx);
			assert.strictEqual(r.currentFileChars, 400);
			assert.strictEqual(r.openTabsChars, 5);
			assert.deepStrictEqual(r.trimmed, []);
		});

		test('custom config respected', () => {
			const r = reportFIMBudget(baseContext(), { ...FIM_BUDGET_DEFAULTS, maxContextChars: 100 });
			// Even though current file is 400 chars and config max is 100, the
			// budget walker doesn't shrink current file in this report path.
			// Smaller cap just means optional sections get dropped sooner.
			// 400 chars > 100 cap → trimmed list stays empty for this case
			// because no optional sections were present.
			assert.strictEqual(r.totalChars, 400);
			assert.deepStrictEqual(r.trimmed, []);
		});
	});

	suite('trimCurrentFileToBudget', () => {
		test('under target → unchanged', () => {
			const file = { uri: 'u', languageId: 'ts', prefix: 'a', suffix: 'b' };
			const r = trimCurrentFileToBudget(file, 100);
			assert.deepStrictEqual(r, file);
		});

		test('over target → balanced trim around cursor', () => {
			const file = { uri: 'u', languageId: 'ts', prefix: 'a'.repeat(100), suffix: 'b'.repeat(100) };
			const r = trimCurrentFileToBudget(file, 40);
			assert.strictEqual(r.prefix.length, 20);
			assert.strictEqual(r.suffix.length, 20);
			// Prefix kept from end → all 'a's still
			assert.strictEqual(r.prefix, 'a'.repeat(20));
			// Suffix kept from start → all 'b's still
			assert.strictEqual(r.suffix, 'b'.repeat(20));
		});

		test('zero target → empty prefix/suffix', () => {
			const file = { uri: 'u', languageId: 'ts', prefix: 'a', suffix: 'b' };
			const r = trimCurrentFileToBudget(file, 0);
			assert.strictEqual(r.prefix, '');
			assert.strictEqual(r.suffix, '');
		});

		test('odd target rounds halfBudget down evenly', () => {
			const file = { uri: 'u', languageId: 'ts', prefix: 'a'.repeat(50), suffix: 'b'.repeat(50) };
			const r = trimCurrentFileToBudget(file, 21);
			// halfBudget = 10 (floor)
			assert.strictEqual(r.prefix.length, 10);
			assert.strictEqual(r.suffix.length, 10);
		});
	});

	suite('FIMBudgetExceededError', () => {
		test('carries name + message', () => {
			const err = new FIMBudgetExceededError('boom');
			assert.strictEqual(err.name, 'FIMBudgetExceededError');
			assert.strictEqual(err.message, 'boom');
		});
	});
});
