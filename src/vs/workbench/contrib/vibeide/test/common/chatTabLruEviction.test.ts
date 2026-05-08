/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	pickTabToEvict,
	decideOpenNewTab,
	ChatTabSnapshot,
} from '../../common/chatTabLruEviction.js';

const tab = (id: string, lastFocusedAt: number, extra: Partial<ChatTabSnapshot> = {}): ChatTabSnapshot => ({
	id, lastFocusedAt, isFocused: false, ...extra,
});

suite('Chat tab LRU eviction — pure helpers (K.4 / 947)', () => {

	suite('pickTabToEvict', () => {
		test('empty list → block(no-tabs)', () => {
			assert.deepStrictEqual(pickTabToEvict([]), { kind: 'block', reason: 'no-tabs' });
		});

		test('picks the tab with the smallest lastFocusedAt', () => {
			const tabs = [tab('a', 100), tab('b', 50), tab('c', 200)];
			assert.deepStrictEqual(pickTabToEvict(tabs), { kind: 'evict', tabId: 'b' });
		});

		test('skips focused tab', () => {
			const tabs = [tab('a', 50, { isFocused: true }), tab('b', 100)];
			assert.deepStrictEqual(pickTabToEvict(tabs), { kind: 'evict', tabId: 'b' });
		});

		test('skips streaming tab', () => {
			const tabs = [tab('a', 50, { isStreaming: true }), tab('b', 100)];
			assert.deepStrictEqual(pickTabToEvict(tabs), { kind: 'evict', tabId: 'b' });
		});

		test('skips pinned tab', () => {
			const tabs = [tab('a', 50, { isPinned: true }), tab('b', 100)];
			assert.deepStrictEqual(pickTabToEvict(tabs), { kind: 'evict', tabId: 'b' });
		});

		test('all protected → block(all-tabs-protected)', () => {
			const tabs = [
				tab('a', 50, { isFocused: true }),
				tab('b', 100, { isPinned: true }),
				tab('c', 200, { isStreaming: true }),
			];
			assert.deepStrictEqual(pickTabToEvict(tabs), { kind: 'block', reason: 'all-tabs-protected' });
		});

		test('stable tie-break by insertion order', () => {
			const tabs = [tab('a', 100), tab('b', 100), tab('c', 100)];
			assert.deepStrictEqual(pickTabToEvict(tabs), { kind: 'evict', tabId: 'a' });
		});
	});

	suite('decideOpenNewTab', () => {
		test('under cap → kind=none', () => {
			const r = decideOpenNewTab([tab('a', 100)], 5);
			assert.deepStrictEqual(r, { kind: 'none' });
		});

		test('at cap → evicts LRU', () => {
			const tabs = [tab('a', 100), tab('b', 50), tab('c', 200), tab('d', 80), tab('e', 300)];
			const r = decideOpenNewTab(tabs, 5);
			assert.deepStrictEqual(r, { kind: 'evict', tabId: 'b' });
		});

		test('all protected at cap → block', () => {
			const tabs = [
				tab('a', 100, { isFocused: true }),
				tab('b', 50, { isPinned: true }),
			];
			const r = decideOpenNewTab(tabs, 2);
			assert.deepStrictEqual(r, { kind: 'block', reason: 'all-tabs-protected' });
		});

		test('rejects non-positive cap', () => {
			assert.deepStrictEqual(decideOpenNewTab([tab('a', 0)], 0), { kind: 'block', reason: 'all-tabs-protected' });
			assert.deepStrictEqual(decideOpenNewTab([tab('a', 0)], -1), { kind: 'block', reason: 'all-tabs-protected' });
		});

		test('rejects non-finite cap', () => {
			assert.deepStrictEqual(decideOpenNewTab([], NaN), { kind: 'block', reason: 'all-tabs-protected' });
		});
	});
});
