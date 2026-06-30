/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	resolveModelForPath,
	decodeRoutingRules,
	findShadowedRule,
	ModelRoutingRule,
} from '../../common/modelRoutingByPath.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const rule = (pattern: string, modelId: string): ModelRoutingRule => ({ pattern, modelId });

suite('Per-file model routing (929)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('resolveModelForPath', () => {
		test('first matching rule wins', () => {
			const r = resolveModelForPath('docs/README.md', [
				rule('**/*.md', 'haiku'),
				rule('**/*.ts', 'opus'),
			], 'sonnet');
			assert.strictEqual(r.source, 'rule');
			assert.strictEqual(r.resolvedModelId, 'haiku');
			assert.strictEqual(r.matchedPattern, '**/*.md');
		});

		test('falls back when nothing matches', () => {
			const r = resolveModelForPath('build.js', [rule('**/*.md', 'haiku')], 'sonnet');
			assert.deepStrictEqual(r, { resolvedModelId: 'sonnet', source: 'fallback' });
		});

		test('empty path → fallback', () => {
			const r = resolveModelForPath('', [rule('**/*', 'haiku')], 'sonnet');
			assert.strictEqual(r.source, 'fallback');
		});

		test('malformed rule is skipped', () => {
			const rules: ModelRoutingRule[] = [
				{ pattern: '', modelId: 'x' } as ModelRoutingRule,
				{ pattern: '**/*.md', modelId: 'haiku' },
			];
			const r = resolveModelForPath('a.md', rules, 'sonnet');
			assert.strictEqual(r.resolvedModelId, 'haiku');
		});

		test('Windows path separators normalised', () => {
			const r = resolveModelForPath('src\\vs\\foo.ts', [rule('src/vs/**', 'opus')], 'sonnet');
			assert.strictEqual(r.resolvedModelId, 'opus');
		});

		test('order matters — earlier rule shadows later', () => {
			const r = resolveModelForPath('test/spec/foo.spec.ts', [
				rule('**/*.ts', 'opus'),
				rule('**/*.spec.ts', 'sonnet'), // shadowed
			], 'haiku');
			assert.strictEqual(r.resolvedModelId, 'opus');
		});
	});

	suite('decodeRoutingRules', () => {
		test('null / undefined → empty list', () => {
			assert.deepStrictEqual(decodeRoutingRules(null), { ok: true, value: [] });
			assert.deepStrictEqual(decodeRoutingRules(undefined), { ok: true, value: [] });
		});

		test('rejects non-array', () => {
			assert.deepStrictEqual(decodeRoutingRules({}), { ok: false, reason: 'not-an-array' });
		});

		test('rejects missing pattern', () => {
			const r = decodeRoutingRules([{ modelId: 'haiku' }]);
			assert.deepStrictEqual(r, { ok: false, reason: 'rules[0]:pattern-missing' });
		});

		test('rejects missing modelId', () => {
			const r = decodeRoutingRules([{ pattern: '**/*.md' }]);
			assert.deepStrictEqual(r, { ok: false, reason: 'rules[0]:modelId-missing' });
		});

		test('happy path returns parsed list', () => {
			const r = decodeRoutingRules([
				{ pattern: '**/*.md', modelId: 'haiku' },
				{ pattern: 'src/vs/**', modelId: 'opus' },
			]);
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(r.value.length, 2); }
		});
	});

	suite('findShadowedRule', () => {
		test('returns -1 for well-ordered rules', () => {
			assert.strictEqual(findShadowedRule([
				rule('**/*.md', 'haiku'),
				rule('src/vs/**', 'opus'),
			]), -1);
		});

		test('detects ** at start shadowing everything else', () => {
			assert.strictEqual(findShadowedRule([
				rule('**', 'sonnet'),
				rule('**/*.md', 'haiku'),
			]), 1);
		});

		test('detects **/* at start', () => {
			assert.strictEqual(findShadowedRule([
				rule('**/*', 'sonnet'),
				rule('src/**', 'opus'),
			]), 1);
		});

		test('catch-all at end is fine', () => {
			assert.strictEqual(findShadowedRule([
				rule('**/*.md', 'haiku'),
				rule('**', 'sonnet'),
			]), -1);
		});
	});
});
