/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	decideOnThreadDeletion,
	decideOnZombieTab,
	OpenChatTab,
} from '../../common/chatTabBindingPolicy.js';

const tab = (tabId: string, threadId: string, extra: Partial<OpenChatTab> = {}): OpenChatTab => ({
	tabId, boundThreadId: threadId, isFocused: false, ...extra,
});

suite('Chat tab binding policy — pure helpers (K.4 / 944)', () => {

	suite('decideOnThreadDeletion — strict policy', () => {
		test('closes bound tab without unsent draft', () => {
			const r = decideOnThreadDeletion({
				policy: 'strict',
				deletedThreadId: 't1',
				openTabs: [tab('tabA', 't1')],
			});
			assert.deepStrictEqual(r, [{ kind: 'close-tab', tabId: 'tabA', reason: 'thread-deleted' }]);
		});

		test('blocks close on bound tab with unsent draft', () => {
			const r = decideOnThreadDeletion({
				policy: 'strict',
				deletedThreadId: 't1',
				openTabs: [tab('tabA', 't1', { hasUnsentDraft: true })],
			});
			assert.deepStrictEqual(r, [{ kind: 'warn-close-blocked', tabId: 'tabA', reason: 'unsent-draft' }]);
		});

		test('skips unbound tabs', () => {
			const r = decideOnThreadDeletion({
				policy: 'strict',
				deletedThreadId: 't1',
				openTabs: [tab('tabA', 't2'), tab('tabB', 't3')],
			});
			assert.deepStrictEqual(r, [{ kind: 'no-op' }]);
		});

		test('multiple bound tabs all get close-tab', () => {
			const r = decideOnThreadDeletion({
				policy: 'strict',
				deletedThreadId: 't1',
				openTabs: [tab('tabA', 't1'), tab('tabB', 't1'), tab('tabC', 't2')],
			});
			assert.strictEqual(r.length, 2);
			assert.strictEqual(r[0].kind, 'close-tab');
			assert.strictEqual(r[1].kind, 'close-tab');
		});
	});

	suite('decideOnThreadDeletion — rebindable policy', () => {
		test('unbinds tab regardless of draft', () => {
			const r = decideOnThreadDeletion({
				policy: 'rebindable',
				deletedThreadId: 't1',
				openTabs: [tab('tabA', 't1', { hasUnsentDraft: true })],
			});
			assert.deepStrictEqual(r, [{ kind: 'unbind-tab', tabId: 'tabA', reason: 'rebindable-policy' }]);
		});

		test('still skips unbound tabs', () => {
			const r = decideOnThreadDeletion({
				policy: 'rebindable',
				deletedThreadId: 't1',
				openTabs: [tab('tabA', 't2')],
			});
			assert.deepStrictEqual(r, [{ kind: 'no-op' }]);
		});
	});

	suite('decideOnZombieTab', () => {
		test('no-op when thread still exists', () => {
			const known = new Set(['t1', 't2']);
			const r = decideOnZombieTab(tab('tabA', 't1'), known, 'strict');
			assert.deepStrictEqual(r, { kind: 'no-op' });
		});

		test('strict closes when zombie has no draft', () => {
			const r = decideOnZombieTab(tab('tabA', 'gone'), new Set(['t1']), 'strict');
			assert.deepStrictEqual(r, { kind: 'close-tab', tabId: 'tabA', reason: 'thread-deleted' });
		});

		test('strict blocks close when zombie has draft', () => {
			const r = decideOnZombieTab(tab('tabA', 'gone', { hasUnsentDraft: true }), new Set(['t1']), 'strict');
			assert.deepStrictEqual(r, { kind: 'warn-close-blocked', tabId: 'tabA', reason: 'unsent-draft' });
		});

		test('rebindable unbinds zombie regardless of draft', () => {
			const r = decideOnZombieTab(tab('tabA', 'gone', { hasUnsentDraft: true }), new Set(['t1']), 'rebindable');
			assert.deepStrictEqual(r, { kind: 'unbind-tab', tabId: 'tabA', reason: 'rebindable-policy' });
		});
	});
});
