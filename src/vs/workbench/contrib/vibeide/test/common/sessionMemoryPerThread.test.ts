/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	createEmptySessionMemoryStore,
	decodeSessionMemoryStore,
	appendSessionMemory,
	touchSessionMemory,
	decaySessionMemory,
	getRecentSessionMemories,
	SESSION_MEMORY_TTL_MS,
	SESSION_MEMORY_MAX_PER_THREAD,
	SESSION_MEMORY_MAX_CONTENT_CHARS,
} from '../../common/sessionMemoryPerThread.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const NOW = 1_750_000_000_000;

suite('Session memory per thread — pure helpers (K.3 / 934)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeSessionMemoryStore', () => {
		test('empty store round-trips', () => {
			const empty = createEmptySessionMemoryStore();
			const decoded = decodeSessionMemoryStore(empty);
			assert.deepStrictEqual(decoded, { ok: true, value: empty });
		});

		test('rejects non-object', () => {
			assert.deepStrictEqual(decodeSessionMemoryStore(null), { ok: false, reason: 'not-an-object' });
			assert.deepStrictEqual(decodeSessionMemoryStore('foo'), { ok: false, reason: 'not-an-object' });
		});

		test('rejects unknown version', () => {
			const r = decodeSessionMemoryStore({ v: 2, byThread: {} });
			assert.deepStrictEqual(r, { ok: false, reason: 'unsupported-version:2' });
		});

		test('rejects missing byThread', () => {
			assert.deepStrictEqual(decodeSessionMemoryStore({ v: 1 }), { ok: false, reason: 'byThread-missing' });
		});

		test('rejects malformed entry', () => {
			const bad = { v: 1, byThread: { t1: [{ foo: 'bar' }] } };
			const r = decodeSessionMemoryStore(bad);
			assert.strictEqual(r.ok, false);
			if (!r.ok) {
				assert.match(r.reason, /^byThread\.t1-bad-entry/);
			}
		});

		test('accepts valid entry', () => {
			const valid = {
				v: 1,
				byThread: {
					t1: [{ id: 'a', threadId: 't1', createdAt: NOW, updatedAt: NOW, kind: 'decision', content: 'x' }],
				},
			};
			const r = decodeSessionMemoryStore(valid);
			assert.strictEqual(r.ok, true);
		});
	});

	suite('appendSessionMemory', () => {
		test('appends to empty store', () => {
			const store = createEmptySessionMemoryStore();
			const next = appendSessionMemory(store, {
				id: 'a',
				threadId: 't1',
				kind: 'decision',
				content: 'pick option A',
			}, NOW);
			assert.strictEqual(next.byThread.t1.length, 1);
			assert.strictEqual(next.byThread.t1[0].createdAt, NOW);
			assert.strictEqual(next.byThread.t1[0].updatedAt, NOW);
		});

		test('does not mutate input store', () => {
			const store = createEmptySessionMemoryStore();
			appendSessionMemory(store, { id: 'a', threadId: 't1', kind: 'decision', content: 'x' }, NOW);
			assert.deepStrictEqual(store, createEmptySessionMemoryStore());
		});

		test('truncates oversized content', () => {
			const store = createEmptySessionMemoryStore();
			const big = 'x'.repeat(SESSION_MEMORY_MAX_CONTENT_CHARS + 100);
			const next = appendSessionMemory(store, { id: 'a', threadId: 't1', kind: 'observation', content: big }, NOW);
			assert.strictEqual(next.byThread.t1[0].content.length, SESSION_MEMORY_MAX_CONTENT_CHARS);
		});

		test('drops oldest when over per-thread cap', () => {
			let store = createEmptySessionMemoryStore();
			for (let i = 0; i < SESSION_MEMORY_MAX_PER_THREAD + 5; i++) {
				store = appendSessionMemory(store, {
					id: `e-${i}`,
					threadId: 't1',
					kind: 'observation',
					content: 'x',
				}, NOW + i);
			}
			assert.strictEqual(store.byThread.t1.length, SESSION_MEMORY_MAX_PER_THREAD);
			// First 5 entries (oldest by updatedAt) should be gone.
			const ids = store.byThread.t1.map(e => e.id);
			assert.ok(!ids.includes('e-0'));
			assert.ok(!ids.includes('e-4'));
			assert.ok(ids.includes('e-5'));
		});
	});

	suite('touchSessionMemory', () => {
		test('updates updatedAt only for matching entry', () => {
			let store = createEmptySessionMemoryStore();
			store = appendSessionMemory(store, { id: 'a', threadId: 't1', kind: 'decision', content: 'x' }, NOW);
			store = appendSessionMemory(store, { id: 'b', threadId: 't1', kind: 'decision', content: 'y' }, NOW);
			const later = NOW + 60_000;
			const next = touchSessionMemory(store, 't1', 'a', later);
			const a = next.byThread.t1.find(e => e.id === 'a')!;
			const b = next.byThread.t1.find(e => e.id === 'b')!;
			assert.strictEqual(a.updatedAt, later);
			assert.strictEqual(b.updatedAt, NOW);
		});

		test('no-op for unknown thread', () => {
			const store = createEmptySessionMemoryStore();
			const next = touchSessionMemory(store, 'unknown', 'x', NOW);
			assert.strictEqual(next, store);
		});
	});

	suite('decaySessionMemory', () => {
		test('drops entries older than TTL', () => {
			let store = createEmptySessionMemoryStore();
			store = appendSessionMemory(store, { id: 'old', threadId: 't1', kind: 'decision', content: 'x' }, NOW - SESSION_MEMORY_TTL_MS - 1);
			store = appendSessionMemory(store, { id: 'fresh', threadId: 't1', kind: 'decision', content: 'y' }, NOW);
			const next = decaySessionMemory(store, NOW);
			const ids = next.byThread.t1.map(e => e.id);
			assert.deepStrictEqual(ids, ['fresh']);
		});

		test('drops entries from closed threads regardless of TTL', () => {
			let store = createEmptySessionMemoryStore();
			store = appendSessionMemory(store, { id: 'a', threadId: 't1', kind: 'decision', content: 'x' }, NOW);
			store = appendSessionMemory(store, { id: 'b', threadId: 't2', kind: 'decision', content: 'y' }, NOW);
			const next = decaySessionMemory(store, NOW, new Set(['t1']));
			assert.strictEqual(next.byThread.t1, undefined);
			assert.strictEqual(next.byThread.t2.length, 1);
		});

		test('removes empty thread keys after decay', () => {
			let store = createEmptySessionMemoryStore();
			store = appendSessionMemory(store, { id: 'old', threadId: 't1', kind: 'decision', content: 'x' }, NOW - SESSION_MEMORY_TTL_MS - 1);
			const next = decaySessionMemory(store, NOW);
			assert.deepStrictEqual(next.byThread, {});
		});
	});

	suite('getRecentSessionMemories', () => {
		test('returns most-recently-touched first', () => {
			let store = createEmptySessionMemoryStore();
			store = appendSessionMemory(store, { id: 'a', threadId: 't1', kind: 'decision', content: 'x' }, NOW);
			store = appendSessionMemory(store, { id: 'b', threadId: 't1', kind: 'decision', content: 'y' }, NOW + 1000);
			store = appendSessionMemory(store, { id: 'c', threadId: 't1', kind: 'observation', content: 'z' }, NOW + 2000);
			const result = getRecentSessionMemories(store, 't1', 2);
			assert.deepStrictEqual(result.map(e => e.id), ['c', 'b']);
		});

		test('filters by kind', () => {
			let store = createEmptySessionMemoryStore();
			store = appendSessionMemory(store, { id: 'a', threadId: 't1', kind: 'decision', content: 'x' }, NOW);
			store = appendSessionMemory(store, { id: 'b', threadId: 't1', kind: 'observation', content: 'y' }, NOW + 1000);
			const result = getRecentSessionMemories(store, 't1', 5, 'decision');
			assert.deepStrictEqual(result.map(e => e.id), ['a']);
		});

		test('empty for unknown thread', () => {
			const store = createEmptySessionMemoryStore();
			assert.deepStrictEqual(getRecentSessionMemories(store, 'nope', 5), []);
		});
	});
});
