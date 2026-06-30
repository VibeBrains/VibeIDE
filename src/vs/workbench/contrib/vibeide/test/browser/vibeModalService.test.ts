/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


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
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('VibeModalService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('showModal + resolveHead — basic flow', async () => {
		const svc = store.add(new VibeModalService());
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
		const svc = store.add(new VibeModalService());
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
		const svc = store.add(new VibeModalService());
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
		const svc = store.add(new VibeModalService());
		void svc.showModal({
			title: 'T',
			buttons: [{ id: 'ok', label: 'OK' }],
			dismissible: false,
		});
		svc.dismissHead();
		assert.strictEqual(svc.getQueue().length, 1, 'queue head should remain');
	});

	test('FIFO order — multiple concurrent modals serialize', async () => {
		const svc = store.add(new VibeModalService());
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
		const svc = store.add(new VibeModalService());
		let fired = 0;
		svc.onDidChangeQueue(() => { fired += 1; });

		const p = svc.showModal({ title: 'T', buttons: [{ id: 'ok', label: 'OK' }] });
		assert.strictEqual(fired, 1, 'should fire on push');

		svc.resolveHead('ok');
		assert.strictEqual(fired, 2, 'should fire on resolve');
		await p;
	});

	test('onDidChangeQueue does NOT fire on dismiss no-op (non-dismissible)', () => {
		const svc = store.add(new VibeModalService());
		let fired = 0;
		svc.onDidChangeQueue(() => { fired += 1; });

		void svc.showModal({ title: 'T', buttons: [{ id: 'ok', label: 'OK' }], dismissible: false });
		assert.strictEqual(fired, 1);

		svc.dismissHead();
		assert.strictEqual(fired, 1, 'dismiss no-op should not fire change event');
	});

	test('resolveHead no-op on empty queue', () => {
		const svc = store.add(new VibeModalService());
		svc.resolveHead('nope'); // should not throw
		assert.strictEqual(svc.getQueue().length, 0);
	});

	test('dismissHead no-op on empty queue', () => {
		const svc = store.add(new VibeModalService());
		svc.dismissHead(); // should not throw
		assert.strictEqual(svc.getQueue().length, 0);
	});

	test('getQueue returns a fresh snapshot each call (immutable view)', () => {
		const svc = store.add(new VibeModalService());
		void svc.showModal({ title: 'T', buttons: [{ id: 'ok', label: 'OK' }] });
		const snapshot1 = svc.getQueue();
		const snapshot2 = svc.getQueue();
		assert.notStrictEqual(snapshot1, snapshot2, 'each call returns new array');
		assert.strictEqual(snapshot1.length, snapshot2.length);
		assert.strictEqual(snapshot1[0].id, snapshot2[0].id);
	});

	test('id is monotonically increasing', async () => {
		const svc = store.add(new VibeModalService());
		const p1 = svc.showModal({ title: '1', buttons: [{ id: 'x', label: 'X' }] });
		const p2 = svc.showModal({ title: '2', buttons: [{ id: 'x', label: 'X' }] });
		const ids = svc.getQueue().map(e => e.id);
		assert.ok(ids[1] > ids[0], `expected ids[1] > ids[0], got ${JSON.stringify(ids)}`);
		svc.resolveHead('x');
		svc.resolveHead('x');
		await Promise.all([p1, p2]);
	});

	test('strongly typed button id (TypeScript narrowing)', async () => {
		const svc = store.add(new VibeModalService());
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

	test('dispose resolves all pending modals with __dismiss__', async () => {
		const svc = store.add(new VibeModalService());
		const p1 = svc.showModal({ title: 'A', buttons: [{ id: 'ok', label: 'OK' }] });
		const p2 = svc.showModal({ title: 'B', buttons: [{ id: 'ok', label: 'OK' }], dismissible: false });
		assert.strictEqual(svc.getQueue().length, 2);
		svc.dispose();
		const [r1, r2] = await Promise.all([p1, p2]);
		// Even `dismissible: false` modal is resolved on dispose — service teardown
		// is unconditional; callers should branch on `__dismiss__` instead of
		// expecting it to mean "user dismissed".
		assert.strictEqual(r1.buttonId, VIBE_MODAL_DISMISS_ID);
		assert.strictEqual(r2.buttonId, VIBE_MODAL_DISMISS_ID);
		assert.strictEqual(svc.getQueue().length, 0);
	});

	test('updateHeadLoading toggles loading + fires change event', () => {
		const svc = store.add(new VibeModalService());
		let fired = 0;
		svc.onDidChangeQueue(() => { fired += 1; });
		void svc.showModal({ title: 'T', buttons: [{ id: 'ok', label: 'OK' }] });
		assert.strictEqual(fired, 1);

		svc.updateHeadLoading(true);
		assert.strictEqual(fired, 2);
		assert.strictEqual(svc.getQueue()[0].options.loading, true);

		// Setting the same value is no-op (no event fired).
		svc.updateHeadLoading(true);
		assert.strictEqual(fired, 2);

		svc.updateHeadLoading(false);
		assert.strictEqual(fired, 3);
		assert.strictEqual(svc.getQueue()[0].options.loading, false);
	});

	test('updateHeadLoading no-op on empty queue', () => {
		const svc = store.add(new VibeModalService());
		svc.updateHeadLoading(true); // should not throw
		assert.strictEqual(svc.getQueue().length, 0);
	});

	test('confirmModal — primary returns true', async () => {
		const svc = store.add(new VibeModalService());
		const p = svc.confirmModal({ title: 'Delete?', body: 'Are you sure?' });
		// Inspect queue: should be one entry with 'cancel' and 'ok' buttons.
		const entry = svc.getQueue()[0];
		assert.ok(entry);
		assert.strictEqual(entry.options.buttons.length, 2);
		assert.strictEqual(entry.options.buttons[0].id, 'cancel');
		assert.strictEqual(entry.options.buttons[1].id, 'ok');
		assert.strictEqual(entry.options.buttons[1].role, 'primary');
		svc.resolveHead('ok');
		assert.strictEqual(await p, true);
	});

	test('confirmModal — cancel returns false', async () => {
		const svc = store.add(new VibeModalService());
		const p = svc.confirmModal({ title: 'Delete?' });
		svc.resolveHead('cancel');
		assert.strictEqual(await p, false);
	});

	test('confirmModal — dismiss returns false', async () => {
		const svc = store.add(new VibeModalService());
		const p = svc.confirmModal({ title: 'Delete?' });
		svc.dismissHead();
		assert.strictEqual(await p, false);
	});

	test('confirmModal danger:true marks OK as danger role', () => {
		const svc = store.add(new VibeModalService());
		void svc.confirmModal({ title: 'Delete?', danger: true });
		const okButton = svc.getQueue()[0].options.buttons[1];
		assert.strictEqual(okButton.id, 'ok');
		assert.strictEqual(okButton.role, 'danger');
	});

	test('confirmModal custom labels', () => {
		const svc = store.add(new VibeModalService());
		void svc.confirmModal({
			title: 'Save?',
			okLabel: 'Сохранить',
			cancelLabel: 'Не сохранять',
		});
		const buttons = svc.getQueue()[0].options.buttons;
		assert.strictEqual(buttons[0].label, 'Не сохранять');
		assert.strictEqual(buttons[1].label, 'Сохранить');
	});

	test('closeHead with explicit buttonId resolves accordingly', async () => {
		const svc = store.add(new VibeModalService());
		const p = svc.showModal({
			title: 'T',
			buttons: [{ id: 'ok', label: 'OK' }],
			dismissible: false, // even non-dismissible can be closed programmatically
		});
		svc.closeHead('ok');
		const result = await p;
		assert.strictEqual(result.buttonId, 'ok');
	});

	test('closeHead without buttonId resolves as __dismiss__', async () => {
		const svc = store.add(new VibeModalService());
		const p = svc.showModal({
			title: 'T',
			buttons: [{ id: 'ok', label: 'OK' }],
			dismissible: false,
		});
		svc.closeHead();
		const result = await p;
		assert.strictEqual(result.buttonId, VIBE_MODAL_DISMISS_ID);
	});

	test('closeHead with inputValue passes it through', async () => {
		const svc = store.add(new VibeModalService());
		const p = svc.showModal({ title: 'T', buttons: [{ id: 'ok', label: 'OK' }], input: { placeholder: 'x' } });
		svc.closeHead('ok', 'value');
		const result = await p;
		assert.strictEqual(result.inputValue, 'value');
	});

	test('closeHead no-op on empty queue', () => {
		const svc = store.add(new VibeModalService());
		svc.closeHead('ok'); // should not throw
		assert.strictEqual(svc.getQueue().length, 0);
	});

	suite('dismissHeadWithVeto', () => {

		test('no veto callback → behaves like dismissHead', async () => {
			const svc = store.add(new VibeModalService());
			const p = svc.showModal({ title: 'T', buttons: [{ id: 'ok', label: 'OK' }] });
			const ok = await svc.dismissHeadWithVeto();
			assert.strictEqual(ok, true);
			const r = await p;
			assert.strictEqual(r.buttonId, VIBE_MODAL_DISMISS_ID);
		});

		test('non-dismissible → returns false, modal stays', async () => {
			const svc = store.add(new VibeModalService());
			void svc.showModal({ title: 'T', buttons: [{ id: 'ok', label: 'OK' }], dismissible: false });
			const ok = await svc.dismissHeadWithVeto();
			assert.strictEqual(ok, false);
			assert.strictEqual(svc.getQueue().length, 1);
		});

		test('callback returning false vetoes dismiss', async () => {
			const svc = store.add(new VibeModalService());
			let called = 0;
			void svc.showModal({
				title: 'T',
				buttons: [{ id: 'ok', label: 'OK' }],
				onBeforeDismiss: () => { called += 1; return false; },
			});
			const ok = await svc.dismissHeadWithVeto();
			assert.strictEqual(ok, false);
			assert.strictEqual(called, 1);
			assert.strictEqual(svc.getQueue().length, 1);
		});

		test('callback returning true allows dismiss', async () => {
			const svc = store.add(new VibeModalService());
			const p = svc.showModal({
				title: 'T',
				buttons: [{ id: 'ok', label: 'OK' }],
				onBeforeDismiss: () => true,
			});
			const ok = await svc.dismissHeadWithVeto();
			assert.strictEqual(ok, true);
			const r = await p;
			assert.strictEqual(r.buttonId, VIBE_MODAL_DISMISS_ID);
		});

		test('async callback returning false vetoes dismiss', async () => {
			const svc = store.add(new VibeModalService());
			void svc.showModal({
				title: 'T',
				buttons: [{ id: 'ok', label: 'OK' }],
				onBeforeDismiss: async () => { await new Promise(r => setTimeout(r, 5)); return false; },
			});
			const ok = await svc.dismissHeadWithVeto();
			assert.strictEqual(ok, false);
			assert.strictEqual(svc.getQueue().length, 1);
		});

		test('throwing callback blocks dismiss (defensive)', async () => {
			const svc = store.add(new VibeModalService());
			void svc.showModal({
				title: 'T',
				buttons: [{ id: 'ok', label: 'OK' }],
				onBeforeDismiss: () => { throw new Error('boom'); },
			});
			const ok = await svc.dismissHeadWithVeto();
			assert.strictEqual(ok, false);
			assert.strictEqual(svc.getQueue().length, 1, 'thrown error should NOT pop modal');
		});

		test('head changed during async callback → original dismiss is no-op', async () => {
			const svc = store.add(new VibeModalService());
			let release: () => void = () => { };
			const blocker = new Promise<boolean>(r => { release = () => r(true); });
			const p1 = svc.showModal({
				title: 'A',
				buttons: [{ id: 'ok', label: 'OK' }],
				onBeforeDismiss: () => blocker,
			});
			const dismissPromise = svc.dismissHeadWithVeto();
			// While the veto is awaiting, externally resolve A and push B.
			svc.resolveHead('ok');
			await p1;
			void svc.showModal({ title: 'B', buttons: [{ id: 'ok', label: 'OK' }] });
			release();
			const ok = await dismissPromise;
			assert.strictEqual(ok, false, 'dismiss should not affect B which replaced A');
			assert.strictEqual(svc.getQueue()[0].options.title, 'B');
		});
	});

	test('showImportantInfoModal — single OK button + auto-dismiss spec', async () => {
		const svc = store.add(new VibeModalService());
		const p = svc.showImportantInfoModal({
			title: 'Saved',
			body: 'Your file was saved.',
			autoDismissAfterMs: 1000,
		});
		const entry = svc.getQueue()[0];
		assert.ok(entry);
		assert.strictEqual(entry.options.buttons.length, 1);
		assert.strictEqual(entry.options.buttons[0].id, 'ok');
		assert.strictEqual(entry.options.icon, 'info');
		assert.strictEqual(entry.options.size, 'small');
		assert.strictEqual(entry.options.autoDismissAfterMs, 1000);
		svc.resolveHead('ok');
		await p; // resolves to undefined
	});

	suite('hotkey on buttons (option shape)', () => {

		test('hotkey field is captured on button', () => {
			const svc = store.add(new VibeModalService());
			void svc.showModal({
				title: 'Confirm',
				buttons: [
					{ id: 'yes', label: 'Yes', role: 'primary', hotkey: 'Y' },
					{ id: 'no', label: 'No', role: 'secondary', hotkey: 'N' },
				],
			});
			const buttons = svc.getQueue()[0].options.buttons;
			assert.strictEqual(buttons[0].hotkey, 'Y');
			assert.strictEqual(buttons[1].hotkey, 'N');
		});
	});

	suite('updateHeadOptions (generic)', () => {

		test('updates arbitrary fields + fires change event', () => {
			const svc = store.add(new VibeModalService());
			let fired = 0;
			svc.onDidChangeQueue(() => { fired += 1; });
			void svc.showModal({ title: 'Save', body: 'A', buttons: [{ id: 'ok', label: 'OK' }] });
			assert.strictEqual(fired, 1);

			const ok1 = svc.updateHeadOptions({ body: 'B' });
			assert.strictEqual(ok1, true);
			assert.strictEqual(svc.getQueue()[0].options.body, 'B');
			assert.strictEqual(fired, 2);

			const ok2 = svc.updateHeadOptions({ loading: true, body: 'C' });
			assert.strictEqual(ok2, true);
			assert.strictEqual(svc.getQueue()[0].options.loading, true);
			assert.strictEqual(svc.getQueue()[0].options.body, 'C');
			assert.strictEqual(fired, 3);
		});

		test('no-op update returns false and does not fire', () => {
			const svc = store.add(new VibeModalService());
			let fired = 0;
			svc.onDidChangeQueue(() => { fired += 1; });
			void svc.showModal({ title: 'T', body: 'X', buttons: [{ id: 'ok', label: 'OK' }] });
			assert.strictEqual(fired, 1);

			const ok = svc.updateHeadOptions({ body: 'X' });
			assert.strictEqual(ok, false);
			assert.strictEqual(fired, 1);
		});

		test('no-op on empty queue', () => {
			const svc = store.add(new VibeModalService());
			const ok = svc.updateHeadOptions({ body: 'x' });
			assert.strictEqual(ok, false);
		});

		test('updateHeadLoading routes through updateHeadOptions', () => {
			const svc = store.add(new VibeModalService());
			void svc.showModal({ title: 'T', buttons: [{ id: 'ok', label: 'OK' }] });
			svc.updateHeadLoading(true);
			assert.strictEqual(svc.getQueue()[0].options.loading, true);
			svc.updateHeadLoading(false);
			assert.strictEqual(svc.getQueue()[0].options.loading, false);
		});

		test('progress field can be updated for stepped async', () => {
			const svc = store.add(new VibeModalService());
			void svc.showModal({
				title: 'Download',
				body: 'Fetching catalog...',
				loading: true,
				buttons: [{ id: 'cancel', label: 'Cancel', role: 'secondary' }],
				progress: { current: 0, total: 10 },
			});
			for (let i = 1; i <= 10; i += 1) {
				svc.updateHeadOptions({ progress: { current: i, total: 10 } });
			}
			assert.strictEqual(svc.getQueue()[0].options.progress?.current, 10);
		});
	});

	suite('dismissHeadWithVeto timeout (audit fix)', () => {

		test('hung callback auto-allows dismiss after timeout', async () => {
			const svc = store.add(new VibeModalService());
			const p = svc.showModal({
				title: 'T',
				buttons: [{ id: 'ok', label: 'OK' }],
				// Callback never resolves — would trap user without timeout.
				onBeforeDismiss: () => new Promise<boolean>(() => { /* hang */ }),
				onBeforeDismissTimeoutMs: 50,
			});
			const ok = await svc.dismissHeadWithVeto();
			assert.strictEqual(ok, true, 'timeout should auto-allow');
			const r = await p;
			assert.strictEqual(r.buttonId, VIBE_MODAL_DISMISS_ID);
		});

		test('timeout=0 disables timeout (caller responsibility)', async () => {
			const svc = store.add(new VibeModalService());
			void svc.showModal({
				title: 'T',
				buttons: [{ id: 'ok', label: 'OK' }],
				onBeforeDismiss: async () => { await new Promise(r => setTimeout(r, 20)); return false; },
				onBeforeDismissTimeoutMs: 0,
			});
			// Should respect the false return, not timeout-allow.
			const ok = await svc.dismissHeadWithVeto();
			assert.strictEqual(ok, false);
			assert.strictEqual(svc.getQueue().length, 1);
		});
	});

	suite('onClose lifecycle callback', () => {

		test('fires with result on resolveHead', async () => {
			const svc = store.add(new VibeModalService());
			let captured: { buttonId: string; inputValue?: string } | null = null;
			const p = svc.showModal({
				title: 'T',
				buttons: [{ id: 'ok', label: 'OK' }],
				onClose: r => { captured = r; },
			});
			svc.resolveHead('ok', 'value');
			await p;
			assert.deepStrictEqual(captured, { buttonId: 'ok', inputValue: 'value' });
		});

		test('fires with __dismiss__ on dismissHead', async () => {
			const svc = store.add(new VibeModalService());
			let buttonId: string | null = null;
			const p = svc.showModal({
				title: 'T',
				buttons: [{ id: 'ok', label: 'OK' }],
				onClose: r => { buttonId = r.buttonId; },
			});
			svc.dismissHead();
			await p;
			assert.strictEqual(buttonId, VIBE_MODAL_DISMISS_ID);
		});

		test('fires on dispose drain', async () => {
			const svc = store.add(new VibeModalService());
			let fired = 0;
			const p = svc.showModal({
				title: 'T',
				buttons: [{ id: 'ok', label: 'OK' }],
				onClose: () => { fired += 1; },
			});
			svc.dispose();
			await p;
			assert.strictEqual(fired, 1);
		});

		test('throwing onClose does not break the resolve flow', async () => {
			const svc = store.add(new VibeModalService());
			const p = svc.showModal({
				title: 'T',
				buttons: [{ id: 'ok', label: 'OK' }],
				onClose: () => { throw new Error('boom'); },
			});
			svc.resolveHead('ok');
			// Should resolve normally even though hook threw.
			const r = await p;
			assert.strictEqual(r.buttonId, 'ok');
		});
	});

	suite('severity presets', () => {

		test('successModal — check icon + auto-dismiss', () => {
			const svc = store.add(new VibeModalService());
			void svc.successModal({ title: 'T', body: 'B' });
			const opts = svc.getQueue()[0].options;
			assert.strictEqual(opts.icon, 'check');
			assert.strictEqual(opts.autoDismissAfterMs, 4000);
			assert.strictEqual(opts.size, 'small');
			assert.strictEqual(opts.buttons.length, 1);
		});

		test('errorModal — error icon + no auto-dismiss', () => {
			const svc = store.add(new VibeModalService());
			void svc.errorModal({ title: 'T', body: 'B' });
			const opts = svc.getQueue()[0].options;
			assert.strictEqual(opts.icon, 'error');
			assert.strictEqual(opts.autoDismissAfterMs, undefined);
			assert.strictEqual(opts.size, 'medium');
		});

		test('warnModal — warning icon + no auto-dismiss', () => {
			const svc = store.add(new VibeModalService());
			void svc.warnModal({ title: 'T', body: 'B' });
			const opts = svc.getQueue()[0].options;
			assert.strictEqual(opts.icon, 'warning');
			assert.strictEqual(opts.autoDismissAfterMs, undefined);
		});

		test('size override propagates', () => {
			const svc = store.add(new VibeModalService());
			void svc.successModal({ title: 'T', body: 'B', size: 'large' });
			assert.strictEqual(svc.getQueue()[0].options.size, 'large');
		});
	});
});
