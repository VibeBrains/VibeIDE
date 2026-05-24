/*--------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

/**
 * Unit tests for VibeModalService state machine (no React). Covers:
 *   - showModal resolves with selected button id + input value
 *   - resolveHead drains the queue head, multiple modals serialize FIFO
 *   - dismissHead honors `dismissible: false` (no-op)
 *   - onDidChangeQueue fires on every queue mutation
 *   - getQueue returns a snapshot (immutable view)
 */

import * as assert from 'assert';
import { VibeModalService } from '../../browser/vibeModalServiceImpl.js';
import { VIBE_MODAL_DISMISS_ID } from '../../common/vibeModalTypes.js';

suite('VibeModalService', () => {

	test('showModal + resolveHead — basic flow', async () => {
		const svc = new VibeModalService();
		const pending = svc.showModal({
			title: 'T',
			buttons: [{ id: 'ok', label: 'OK' }, { id: 'cancel', label: 'Cancel' }],
		});
		assert.strictEqual(svc.getQueue().length, 1);
		svc.resolveHead('ok');
		const result = await pending;
		assert.strictEqual(result.buttonId, 'ok');
		assert.strictEqual(result.inputValue, undefined);
		assert.strictEqual(svc.getQueue().length, 0);
	});

	test('resolveHead with input value passes it through', async () => {
		const svc = new VibeModalService();
		const pending = svc.showModal({
			title: 'T',
			buttons: [{ id: 'ok', label: 'OK' }],
			input: { placeholder: 'enter' },
		});
		svc.resolveHead('ok', 'hello world');
		const result = await pending;
		assert.strictEqual(result.buttonId, 'ok');
		assert.strictEqual(result.inputValue, 'hello world');
	});

	test('dismissHead resolves with __dismiss__ sentinel', async () => {
		const svc = new VibeModalService();
		const pending = svc.showModal({
			title: 'T',
			buttons: [{ id: 'ok', label: 'OK' }],
		});
		svc.dismissHead();
		const result = await pending;
		assert.strictEqual(result.buttonId, VIBE_MODAL_DISMISS_ID);
		assert.strictEqual(svc.getQueue().length, 0);
	});

	test('dismissHead is no-op when dismissible: false', () => {
		const svc = new VibeModalService();
		void svc.showModal({
			title: 'T',
			buttons: [{ id: 'ok', label: 'OK' }],
			dismissible: false,
		});
		svc.dismissHead();
		assert.strictEqual(svc.getQueue().length, 1, 'queue head should remain');
	});

	test('FIFO order — multiple concurrent modals serialize', async () => {
		const svc = new VibeModalService();
		const p1 = svc.showModal({ title: 'First', buttons: [{ id: 'a', label: 'A' }] });
		const p2 = svc.showModal({ title: 'Second', buttons: [{ id: 'b', label: 'B' }] });
		const p3 = svc.showModal({ title: 'Third', buttons: [{ id: 'c', label: 'C' }] });
		assert.strictEqual(svc.getQueue().length, 3);
		assert.strictEqual(svc.getQueue()[0].options.title, 'First');

		svc.resolveHead('a');
		const r1 = await p1;
		assert.strictEqual(r1.buttonId, 'a');
		assert.strictEqual(svc.getQueue()[0].options.title, 'Second');

		svc.resolveHead('b');
		const r2 = await p2;
		assert.strictEqual(r2.buttonId, 'b');

		svc.dismissHead();
		const r3 = await p3;
		assert.strictEqual(r3.buttonId, VIBE_MODAL_DISMISS_ID);
		assert.strictEqual(svc.getQueue().length, 0);
	});

	test('onDidChangeQueue fires on push and resolve', async () => {
		const svc = new VibeModalService();
		let fired = 0;
		svc.onDidChangeQueue(() => { fired += 1; });

		const p = svc.showModal({ title: 'T', buttons: [{ id: 'ok', label: 'OK' }] });
		assert.strictEqual(fired, 1, 'should fire on push');

		svc.resolveHead('ok');
		assert.strictEqual(fired, 2, 'should fire on resolve');
		await p;
	});

	test('onDidChangeQueue does NOT fire on dismiss no-op (non-dismissible)', () => {
		const svc = new VibeModalService();
		let fired = 0;
		svc.onDidChangeQueue(() => { fired += 1; });

		void svc.showModal({ title: 'T', buttons: [{ id: 'ok', label: 'OK' }], dismissible: false });
		assert.strictEqual(fired, 1);

		svc.dismissHead();
		assert.strictEqual(fired, 1, 'dismiss no-op should not fire change event');
	});

	test('resolveHead no-op on empty queue', () => {
		const svc = new VibeModalService();
		svc.resolveHead('nope'); // should not throw
		assert.strictEqual(svc.getQueue().length, 0);
	});

	test('dismissHead no-op on empty queue', () => {
		const svc = new VibeModalService();
		svc.dismissHead(); // should not throw
		assert.strictEqual(svc.getQueue().length, 0);
	});

	test('getQueue returns a fresh snapshot each call (immutable view)', () => {
		const svc = new VibeModalService();
		void svc.showModal({ title: 'T', buttons: [{ id: 'ok', label: 'OK' }] });
		const snapshot1 = svc.getQueue();
		const snapshot2 = svc.getQueue();
		assert.notStrictEqual(snapshot1, snapshot2, 'each call returns new array');
		assert.strictEqual(snapshot1.length, snapshot2.length);
		assert.strictEqual(snapshot1[0].id, snapshot2[0].id);
	});

	test('id is monotonically increasing', async () => {
		const svc = new VibeModalService();
		const p1 = svc.showModal({ title: '1', buttons: [{ id: 'x', label: 'X' }] });
		const p2 = svc.showModal({ title: '2', buttons: [{ id: 'x', label: 'X' }] });
		const ids = svc.getQueue().map(e => e.id);
		assert.ok(ids[1] > ids[0], `expected ids[1] > ids[0], got ${JSON.stringify(ids)}`);
		svc.resolveHead('x');
		svc.resolveHead('x');
		await Promise.all([p1, p2]);
	});

	test('strongly typed button id (TypeScript narrowing)', async () => {
		const svc = new VibeModalService();
		const p = svc.showModal<'apply' | 'edit' | 'cancel'>({
			title: '/commit preview',
			buttons: [
				{ id: 'apply', label: 'Apply', role: 'primary' },
				{ id: 'edit', label: 'Edit', role: 'secondary' },
				{ id: 'cancel', label: 'Cancel', role: 'secondary' },
			],
		});
		svc.resolveHead('apply');
		const result = await p;
		// Type-narrowing check: result.buttonId is 'apply' | 'edit' | 'cancel' | '__dismiss__'.
		// `result.buttonId === 'apply'` is a valid comparison; assert it at runtime.
		assert.strictEqual(result.buttonId, 'apply');
	});
});
