/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	CompletionCache,
	makeCompletionCacheKey,
	hashCompletionPrefix,
} from '../../common/completionCache.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const NOW = 1_750_000_000_000;

suite('Completion LRU cache — pure helpers (L.3 / 1019)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('hashCompletionPrefix', () => {
		test('deterministic for identical input', () => {
			assert.strictEqual(hashCompletionPrefix('foo'), hashCompletionPrefix('foo'));
		});

		test('differs for one-char delta', () => {
			assert.notStrictEqual(hashCompletionPrefix('foo'), hashCompletionPrefix('fop'));
		});

		test('output is 8-char hex', () => {
			assert.match(hashCompletionPrefix('xyz'), /^[0-9a-f]{8}$/);
			assert.match(hashCompletionPrefix(''), /^[0-9a-f]{8}$/);
		});
	});

	suite('makeCompletionCacheKey', () => {
		test('encodes all components', () => {
			const k = makeCompletionCacheKey('file:///a.ts', 10, 5, 'abc');
			assert.ok(k.includes('file:///a.ts'));
			assert.ok(k.includes('10'));
			assert.ok(k.includes('5'));
			assert.ok(k.includes('abc'));
		});

		test('different lines → different keys', () => {
			assert.notStrictEqual(
				makeCompletionCacheKey('a', 1, 1, 'h'),
				makeCompletionCacheKey('a', 2, 1, 'h'),
			);
		});
	});

	suite('CompletionCache', () => {
		test('miss on unknown key', () => {
			const c = new CompletionCache<string>();
			assert.strictEqual(c.get('k', NOW), undefined);
			assert.strictEqual(c.stats().misses, 1);
			assert.strictEqual(c.stats().hits, 0);
		});

		test('hit returns stored value', () => {
			const c = new CompletionCache<string>();
			c.set('k', 'v', NOW);
			assert.strictEqual(c.get('k', NOW), 'v');
			assert.strictEqual(c.stats().hits, 1);
		});

		test('expired entry is a miss and gets dropped', () => {
			const c = new CompletionCache<string>({ ttlMs: 1000 });
			c.set('k', 'v', NOW);
			assert.strictEqual(c.get('k', NOW + 2000), undefined);
			assert.strictEqual(c.debugSize(), 0);
		});

		test('LRU evicts oldest when over cap', () => {
			const c = new CompletionCache<string>({ maxEntries: 2 });
			c.set('a', '1', NOW);
			c.set('b', '2', NOW + 1);
			c.set('c', '3', NOW + 2);
			assert.strictEqual(c.get('a', NOW + 3), undefined); // evicted
			assert.strictEqual(c.get('b', NOW + 3), '2');
			assert.strictEqual(c.get('c', NOW + 3), '3');
			assert.strictEqual(c.stats().evictions, 1);
		});

		test('access bumps recency — touched entry survives', () => {
			const c = new CompletionCache<string>({ maxEntries: 2 });
			c.set('a', '1', NOW);
			c.set('b', '2', NOW + 1);
			c.get('a', NOW + 2); // bump 'a' to most-recent
			c.set('c', '3', NOW + 3); // should evict 'b', not 'a'
			assert.strictEqual(c.get('a', NOW + 4), '1');
			assert.strictEqual(c.get('b', NOW + 4), undefined);
		});

		test('invalidateForUri drops only matching entries', () => {
			const c = new CompletionCache<string>();
			c.set(makeCompletionCacheKey('file:///a.ts', 1, 1, 'h'), 'A', NOW);
			c.set(makeCompletionCacheKey('file:///b.ts', 1, 1, 'h'), 'B', NOW);
			c.set(makeCompletionCacheKey('file:///a.ts', 2, 1, 'h'), 'A2', NOW);
			const dropped = c.invalidateForUri('file:///a.ts');
			assert.strictEqual(dropped, 2);
			assert.strictEqual(c.get(makeCompletionCacheKey('file:///b.ts', 1, 1, 'h'), NOW), 'B');
			assert.strictEqual(c.stats().invalidations, 2);
		});

		test('invalidateForUri returns 0 when nothing matches', () => {
			const c = new CompletionCache<string>();
			c.set(makeCompletionCacheKey('a', 1, 1, 'h'), 'A', NOW);
			assert.strictEqual(c.invalidateForUri('nope'), 0);
		});

		test('clear empties the cache', () => {
			const c = new CompletionCache<string>();
			c.set('a', '1', NOW);
			c.set('b', '2', NOW);
			c.clear();
			assert.strictEqual(c.debugSize(), 0);
			assert.strictEqual(c.get('a', NOW), undefined);
		});

		test('re-set existing key updates value and bumps recency', () => {
			const c = new CompletionCache<string>({ maxEntries: 2 });
			c.set('a', '1', NOW);
			c.set('b', '2', NOW + 1);
			c.set('a', '1b', NOW + 2); // re-insert 'a'
			c.set('c', '3', NOW + 3); // evicts 'b' now (LRU), not 'a'
			assert.strictEqual(c.get('a', NOW + 4), '1b');
			assert.strictEqual(c.get('b', NOW + 4), undefined);
		});
	});
});
