/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	inspectLocaleScreens,
	verifyChatTabDragInvariant,
	verifyMultiWindowLockInvariants,
	E2ESmokeNotImplementedError,
} from '../../common/e2eSmokeContracts.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('e2eSmokeContracts — locale (§522-524, §505)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ru locale flags English text in vibeide.* settings', () => {
		const findings = inspectLocaleScreens('ru', [
			{ screen: 'settings', text: 'Open Recent' },
			{ screen: 'sidebar', text: 'Открыть' },
		]);
		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0].reason, 'english-text');
		assert.strictEqual(findings[0].screen, 'settings');
	});

	test('any locale flags raw localization key leak', () => {
		const findings = inspectLocaleScreens('ru', [
			{ screen: 'palette', text: 'vibeide.command.openSettings' },
		]);
		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0].reason, 'raw-key');
	});

	test('qps-ploc flags untranslated literal (no bracket marker)', () => {
		const findings = inspectLocaleScreens('qps-ploc', [
			{ screen: 'sidebar', text: 'Translate me please' },
			{ screen: 'sidebar', text: '[ÅHelloÅ]' },
		]);
		assert.ok(findings.length >= 1);
		assert.ok(findings.every(f => f.reason === 'placeholder-leak'));
	});

	test('en locale: raw-key still flagged but English passes', () => {
		const findings = inspectLocaleScreens('en', [
			{ screen: 'sidebar', text: 'Open Recent' },
		]);
		assert.strictEqual(findings.length, 0);
	});

	test('empty strings are ignored', () => {
		const findings = inspectLocaleScreens('ru', [
			{ screen: 'sidebar', text: '   ' },
			{ screen: 'sidebar', text: '' },
		]);
		assert.strictEqual(findings.length, 0);
	});
});

suite('e2eSmokeContracts — chat tab drag-drop (§948)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves chatId across drag-drop', () => {
		const before = [
			{ chatId: 'A', groupId: 1, editorIndex: 0 },
			{ chatId: 'B', groupId: 1, editorIndex: 1 },
		];
		const after = [
			{ chatId: 'A', groupId: 1, editorIndex: 0 },
			{ chatId: 'B', groupId: 2, editorIndex: 0 },
		];
		const r = verifyChatTabDragInvariant(before, after);
		assert.strictEqual(r.preserved, true);
		assert.deepStrictEqual(r.violations, []);
	});

	test('flags missing chatId after drag', () => {
		const before = [
			{ chatId: 'A', groupId: 1, editorIndex: 0 },
			{ chatId: 'B', groupId: 1, editorIndex: 1 },
		];
		const after = [
			{ chatId: 'A', groupId: 1, editorIndex: 0 },
		];
		const r = verifyChatTabDragInvariant(before, after);
		assert.strictEqual(r.preserved, false);
		assert.ok(r.violations.some(v => /chatId B disappeared/.test(v)));
	});

	test('flags injected chatId after drag', () => {
		const before = [{ chatId: 'A', groupId: 1, editorIndex: 0 }];
		const after = [
			{ chatId: 'A', groupId: 1, editorIndex: 0 },
			{ chatId: 'X', groupId: 2, editorIndex: 0 },
		];
		const r = verifyChatTabDragInvariant(before, after);
		assert.strictEqual(r.preserved, false);
		assert.ok(r.violations.some(v => /unexpected chatId X/.test(v)));
	});
});

suite('e2eSmokeContracts — multi-window locks (§1065)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('two windows with disjoint locks: ok', () => {
		const r = verifyMultiWindowLockInvariants([
			{ windowId: 'W1', heldLocks: ['workspace-A.lock'], pid: 100, startedAtMs: 1 },
			{ windowId: 'W2', heldLocks: ['workspace-B.lock'], pid: 101, startedAtMs: 2 },
		]);
		assert.strictEqual(r.ok, true);
	});

	test('two windows holding the same lock: violation', () => {
		const r = verifyMultiWindowLockInvariants([
			{ windowId: 'W1', heldLocks: ['plan-edit.lock'], pid: 100, startedAtMs: 1 },
			{ windowId: 'W2', heldLocks: ['plan-edit.lock'], pid: 101, startedAtMs: 2 },
		]);
		assert.strictEqual(r.ok, false);
		assert.ok(r.violations[0].includes('plan-edit.lock'));
	});

	test('invalid pid flagged', () => {
		const r = verifyMultiWindowLockInvariants([
			{ windowId: 'W1', heldLocks: [], pid: 0, startedAtMs: 1 },
		]);
		assert.strictEqual(r.ok, false);
		assert.ok(r.violations[0].includes('invalid pid'));
	});

	test('same window can hold multiple locks without issue', () => {
		const r = verifyMultiWindowLockInvariants([
			{ windowId: 'W1', heldLocks: ['a.lock', 'b.lock', 'c.lock'], pid: 100, startedAtMs: 1 },
		]);
		assert.strictEqual(r.ok, true);
	});
});

suite('e2eSmokeContracts — sentinel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('E2ESmokeNotImplementedError carries scenario name and reference', () => {
		const err = new E2ESmokeNotImplementedError('locale-ru');
		assert.strictEqual(err.name, 'E2ESmokeNotImplementedError');
		assert.match(err.message, /locale-ru/);
		assert.match(err.message, /e2eSmokeContracts\.ts/);
	});
});
