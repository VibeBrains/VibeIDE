/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { logCategoryMatchesPattern, logCategoryAllowed, resolveCategoryLevelWildcard } from '../../common/logCategoryMatch.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('logCategoryMatch (roadmap #3115)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('logCategoryMatchesPattern', () => {
		test('exact name matches only itself', () => {
			assert.strictEqual(logCategoryMatchesPattern('chatThread', 'chatThread'), true);
			assert.strictEqual(logCategoryMatchesPattern('chatThread', 'chat'), false);
		});

		test('prefix* wildcard matches by prefix', () => {
			assert.strictEqual(logCategoryMatchesPattern('chatThread', 'chat*'), true);
			assert.strictEqual(logCategoryMatchesPattern('chatThreadService', 'chat*'), true);
			assert.strictEqual(logCategoryMatchesPattern('llmTurn', 'chat*'), false);
		});

		test('bare * matches everything', () => {
			assert.strictEqual(logCategoryMatchesPattern('anything', '*'), true);
		});
	});

	suite('logCategoryAllowed', () => {
		test('null / empty set allows all', () => {
			assert.strictEqual(logCategoryAllowed('x', null), true);
			assert.strictEqual(logCategoryAllowed('x', undefined), true);
			assert.strictEqual(logCategoryAllowed('x', new Set()), true);
		});

		test('exact membership passes (back-compat)', () => {
			assert.strictEqual(logCategoryAllowed('Tool', new Set(['Tool', 'llmTurn'])), true);
			assert.strictEqual(logCategoryAllowed('ContextGuard', new Set(['Tool', 'llmTurn'])), false);
		});

		test('wildcard membership passes', () => {
			const set = new Set(['chat*', 'llmTurn']);
			assert.strictEqual(logCategoryAllowed('chatThreadService', set), true);
			assert.strictEqual(logCategoryAllowed('llmTurn', set), true);
			assert.strictEqual(logCategoryAllowed('mcpServer', set), false);
		});
	});

	suite('resolveCategoryLevelWildcard', () => {
		test('returns the matching wildcard key', () => {
			assert.strictEqual(resolveCategoryLevelWildcard('chatThread', ['chat*', 'llm*']), 'chat*');
		});

		test('longest (most specific) prefix wins on overlap', () => {
			assert.strictEqual(resolveCategoryLevelWildcard('chatThreadService', ['chat*', 'chatThread*']), 'chatThread*');
		});

		test('ignores exact (non-wildcard) keys — caller handles those', () => {
			assert.strictEqual(resolveCategoryLevelWildcard('chatThread', ['chatThread', 'llm*']), undefined);
		});

		test('returns undefined when nothing matches', () => {
			assert.strictEqual(resolveCategoryLevelWildcard('mcp', ['chat*', 'llm*']), undefined);
		});
	});
});
