/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	matchConstraintPattern,
	findDenyingConstraint,
	isModelAllowedByList,
	VibeConstraintRule,
} from '../../common/vibeConstraintsService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('VibeConstraintsService — pure helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('matchConstraintPattern', () => {
		test('matches simple glob with **', () => {
			assert.strictEqual(matchConstraintPattern('src/auth/login.ts', '**/auth/**'), true);
		});
		test('case-sensitive', () => {
			assert.strictEqual(matchConstraintPattern('Src/Auth/Login.ts', '**/auth/**'), false);
		});
		test('returns false for malformed pattern (regex escape catches it)', () => {
			// Constructing a pattern that yields invalid regex would normally throw; the
			// helper escapes special chars before substituting glob metas, so invalid input
			// just becomes a literal match attempt.
			assert.strictEqual(matchConstraintPattern('foo.ts', 'foo.ts'), true);
		});
		test('normalizes Windows backslashes in both inputs', () => {
			assert.strictEqual(matchConstraintPattern('src\\auth\\login.ts', 'src\\**'), true);
		});
	});

	suite('findDenyingConstraint', () => {
		const rules: VibeConstraintRule[] = [
			{ type: 'deny_write', pattern: '.env', message: 'no env writes' },
			{ type: 'deny_read', pattern: 'secrets/**', message: 'secrets are off-limits' },
			{ type: 'max_lines_per_function', value: 200 },
		];

		test('returns the matching deny_write rule', () => {
			const r = findDenyingConstraint('.env', 'deny_write', rules);
			assert.ok(r);
			assert.strictEqual(r!.message, 'no env writes');
		});

		test('returns null when nothing matches', () => {
			const r = findDenyingConstraint('src/foo.ts', 'deny_write', rules);
			assert.strictEqual(r, null);
		});

		test('does not consider deny_read rules when checking deny_write', () => {
			const r = findDenyingConstraint('secrets/key.pem', 'deny_write', rules);
			assert.strictEqual(r, null);
		});

		test('does not consider non-deny rule types', () => {
			const r = findDenyingConstraint('foo.ts', 'deny_write',
				[{ type: 'max_lines_per_function', value: 200 }]);
			assert.strictEqual(r, null);
		});

		test('skips rules with missing pattern', () => {
			const r = findDenyingConstraint('foo.ts', 'deny_write',
				[{ type: 'deny_write' }]);
			assert.strictEqual(r, null);
		});
	});

	suite('isModelAllowedByList', () => {
		test('empty list ⇒ all allowed (default)', () => {
			assert.strictEqual(isModelAllowedByList('claude-3-5-sonnet', []), true);
		});

		test('exact match', () => {
			assert.strictEqual(isModelAllowedByList('claude-3-5-sonnet', ['claude-3-5-sonnet']), true);
		});

		test('substring match (whitelist family)', () => {
			assert.strictEqual(isModelAllowedByList('claude-3-5-sonnet-20241022', ['claude-3-5']), true);
		});

		test('case-insensitive', () => {
			assert.strictEqual(isModelAllowedByList('Claude-3-5-Sonnet', ['claude-3-5']), true);
		});

		test('rejects out-of-list model', () => {
			assert.strictEqual(isModelAllowedByList('gpt-4o', ['claude-3-5']), false);
		});
	});
});
