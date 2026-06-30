/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decideResume,
	appendChunk,
	evictRetryCache,
	PartialResponse,
	RETRY_CACHE_DEFAULTS,
} from '../../common/responseRetryCache.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const NOW = 1_000_000;

const partial = (overrides: Partial<PartialResponse> = {}): PartialResponse => ({
	requestKey: 'r1',
	startedAt: NOW - 1000,
	updatedAt: NOW,
	chunks: ['hello '],
	totalChars: 6,
	...overrides,
});

suite('Response retry cache (1186)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideResume', () => {
		test('no partial → no-partial', () => {
			assert.deepStrictEqual(decideResume(undefined, true, NOW), { kind: 'no-partial' });
		});

		test('partial with empty chunks → no-partial', () => {
			const p = partial({ chunks: [], totalChars: 0 });
			assert.deepStrictEqual(decideResume(p, true, NOW), { kind: 'no-partial' });
		});

		test('expired partial → expired-partial', () => {
			const p = partial({ updatedAt: NOW - RETRY_CACHE_DEFAULTS.ttlMs - 1 });
			const r = decideResume(p, true, NOW);
			assert.strictEqual(r.kind, 'expired-partial');
			if (r.kind === 'expired-partial') { assert.strictEqual(r.previousChars, 6); }
		});

		test('provider supports prefill → resume-prefill with joined chunks', () => {
			const p = partial({ chunks: ['hello ', 'world'], totalChars: 11 });
			const r = decideResume(p, true, NOW);
			assert.strictEqual(r.kind, 'resume-prefill');
			if (r.kind === 'resume-prefill') {
				assert.strictEqual(r.prefill, 'hello world');
				assert.strictEqual(r.recoveredChars, 11);
			}
		});

		test('provider does NOT support prefill → resume-replay with already-rendered chars', () => {
			const p = partial({ chunks: ['hi'], totalChars: 2 });
			const r = decideResume(p, false, NOW);
			assert.deepStrictEqual(r, { kind: 'resume-replay', alreadyRenderedChars: 2 });
		});

		test('boundary: at TTL → still resume', () => {
			const p = partial({ updatedAt: NOW - RETRY_CACHE_DEFAULTS.ttlMs });
			const r = decideResume(p, true, NOW);
			assert.notStrictEqual(r.kind, 'expired-partial');
		});
	});

	suite('appendChunk', () => {
		test('creates fresh entry when partial absent', () => {
			const r = appendChunk(undefined, 'r1', 'hello', NOW);
			assert.strictEqual(r.requestKey, 'r1');
			assert.deepStrictEqual(r.chunks, ['hello']);
			assert.strictEqual(r.totalChars, 5);
			assert.strictEqual(r.startedAt, NOW);
		});

		test('appends to existing partial without mutating input', () => {
			const p = partial({ chunks: ['a'], totalChars: 1 });
			const r = appendChunk(p, 'r1', 'b', NOW + 100);
			assert.deepStrictEqual(r.chunks, ['a', 'b']);
			assert.strictEqual(r.totalChars, 2);
			assert.strictEqual(r.updatedAt, NOW + 100);
			// original unchanged
			assert.deepStrictEqual(p.chunks, ['a']);
		});

		test('drops oldest chunks past maxCharsPerEntry', () => {
			let p = appendChunk(undefined, 'r1', 'a'.repeat(100), NOW, { ...RETRY_CACHE_DEFAULTS, maxCharsPerEntry: 150 });
			p = appendChunk(p, 'r1', 'b'.repeat(100), NOW + 1, { ...RETRY_CACHE_DEFAULTS, maxCharsPerEntry: 150 });
			// total would be 200; cap is 150 → drop the first 100-char chunk.
			assert.strictEqual(p.totalChars, 100);
			assert.deepStrictEqual(p.chunks, ['b'.repeat(100)]);
		});

		test('preserves at least one chunk even when single chunk exceeds cap', () => {
			const big = 'x'.repeat(500);
			const p = appendChunk(undefined, 'r1', big, NOW, { ...RETRY_CACHE_DEFAULTS, maxCharsPerEntry: 100 });
			assert.strictEqual(p.chunks.length, 1);
			assert.strictEqual(p.totalChars, 500);
		});

		test('preserves startedAt across appends', () => {
			let p = appendChunk(undefined, 'r1', 'a', NOW);
			p = appendChunk(p, 'r1', 'b', NOW + 100);
			p = appendChunk(p, 'r1', 'c', NOW + 200);
			assert.strictEqual(p.startedAt, NOW);
		});
	});

	suite('evictRetryCache', () => {
		test('drops entries older than TTL', () => {
			const cache = new Map<string, PartialResponse>([
				['r1', partial({ updatedAt: NOW - RETRY_CACHE_DEFAULTS.ttlMs - 1 })],
				['r2', partial({ updatedAt: NOW })],
			]);
			const fresh = evictRetryCache(cache, NOW);
			assert.strictEqual(fresh.size, 1);
			assert.ok(fresh.has('r2'));
		});

		test('evicts oldest when over maxEntries', () => {
			const cache = new Map<string, PartialResponse>();
			const cfg = { ...RETRY_CACHE_DEFAULTS, maxEntries: 2 };
			for (let i = 0; i < 5; i++) {
				cache.set(`r${i}`, partial({ updatedAt: NOW - 1000 + i, requestKey: `r${i}` }));
			}
			const fresh = evictRetryCache(cache, NOW, cfg);
			assert.strictEqual(fresh.size, 2);
			assert.ok(fresh.has('r4'));
			assert.ok(fresh.has('r3'));
			assert.ok(!fresh.has('r0'));
		});

		test('empty input → empty output', () => {
			const fresh = evictRetryCache(new Map(), NOW);
			assert.strictEqual(fresh.size, 0);
		});

		test('returns a new map (does not mutate input)', () => {
			const cache = new Map<string, PartialResponse>([['r1', partial()]]);
			const fresh = evictRetryCache(cache, NOW);
			assert.notStrictEqual(fresh, cache);
		});
	});
});
