/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	validateDesktopNotification,
	detectNotificationPlatform,
	urgencyToElectronOptions,
	DesktopNotificationDraft,
} from '../../common/desktopNotificationSpec.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function draft(overrides: Partial<DesktopNotificationDraft> = {}): DesktopNotificationDraft {
	return {
		title: 'Approval needed',
		body: 'Agent is waiting for your approval to run.',
		...overrides,
	};
}

suite('VibeDesktopNotificationService — spec validator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('validateDesktopNotification', () => {
		test('happy path on linux', () => {
			const r = validateDesktopNotification(draft(), 'linux');
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.spec.title, 'Approval needed');
				assert.strictEqual(r.spec.urgency, 'normal');
				assert.strictEqual(r.spec.silent, false);
			}
		});

		test('rejects empty title', () => {
			const r = validateDesktopNotification(draft({ title: '' }), 'linux');
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.issues.includes('title-empty')); }
		});

		test('rejects empty body', () => {
			const r = validateDesktopNotification(draft({ body: '   ' }), 'linux');
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.issues.includes('body-empty')); }
		});

		test('rejects over-long title', () => {
			const r = validateDesktopNotification(draft({ title: 'a'.repeat(100) }), 'linux');
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.issues.includes('title-too-long')); }
		});

		test('rejects over-long body', () => {
			const r = validateDesktopNotification(draft({ body: 'a'.repeat(300) }), 'linux');
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.issues.includes('body-too-long')); }
		});

		test('Windows caps actions at 3', () => {
			const r = validateDesktopNotification(
				draft({
					actions: [
						{ id: 'a', label: 'A' },
						{ id: 'b', label: 'B' },
						{ id: 'c', label: 'C' },
						{ id: 'd', label: 'D' },
					]
				}),
				'win32',
			);
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.issues.includes('too-many-actions')); }
		});

		test('macOS allows up to 5 actions', () => {
			const r = validateDesktopNotification(
				draft({
					actions: [
						{ id: 'a', label: 'A' },
						{ id: 'b', label: 'B' },
						{ id: 'c', label: 'C' },
						{ id: 'd', label: 'D' },
						{ id: 'e', label: 'E' },
					]
				}),
				'darwin',
			);
			assert.strictEqual(r.ok, true);
		});

		test('rejects malformed action id', () => {
			const r = validateDesktopNotification(
				draft({ actions: [{ id: 'BAD ID', label: 'X' }] }),
				'linux',
			);
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.issues.includes('action-id-malformed')); }
		});

		test('rejects empty action label', () => {
			const r = validateDesktopNotification(
				draft({ actions: [{ id: 'ok', label: '   ' }] }),
				'linux',
			);
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.issues.includes('action-label-empty')); }
		});

		test('rejects too-long action label', () => {
			const r = validateDesktopNotification(
				draft({ actions: [{ id: 'ok', label: 'a'.repeat(50) }] }),
				'linux',
			);
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.issues.includes('action-label-too-long')); }
		});

		test('rejects unknown urgency value', () => {
			const r = validateDesktopNotification(
				draft({ urgency: 'panic' as never }),
				'linux',
			);
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.issues.includes('urgency-invalid')); }
		});

		test('icon path must be absolute', () => {
			const r = validateDesktopNotification(
				draft({ iconPath: 'relative/icon.png' }),
				'linux',
			);
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.issues.includes('icon-path-not-absolute')); }
		});

		test('absolute icon paths accepted (POSIX, Windows, file://)', () => {
			for (const p of ['/abs/icon.png', 'C:/abs/icon.png', 'file:///abs/icon.png']) {
				const r = validateDesktopNotification(draft({ iconPath: p }), 'linux');
				assert.strictEqual(r.ok, true, `path ${p} should be accepted`);
			}
		});

		test('collects all issues, not just first', () => {
			const r = validateDesktopNotification(
				draft({ title: '', body: '', urgency: 'wat' as never }),
				'linux',
			);
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.issues.length >= 3); }
		});

		test('normalises trimmed title/body', () => {
			const r = validateDesktopNotification(
				draft({ title: '  Approval  ', body: '  Body  ' }),
				'linux',
			);
			if (r.ok) {
				assert.strictEqual(r.spec.title, 'Approval');
				assert.strictEqual(r.spec.body, 'Body');
			}
		});

		test('silent default false', () => {
			const r = validateDesktopNotification(draft(), 'linux');
			if (r.ok) { assert.strictEqual(r.spec.silent, false); }
		});

		test('silent flag forwarded', () => {
			const r = validateDesktopNotification(draft({ silent: true }), 'linux');
			if (r.ok) { assert.strictEqual(r.spec.silent, true); }
		});
	});

	suite('detectNotificationPlatform', () => {
		test('canonical platforms', () => {
			assert.strictEqual(detectNotificationPlatform('win32'), 'win32');
			assert.strictEqual(detectNotificationPlatform('darwin'), 'darwin');
			assert.strictEqual(detectNotificationPlatform('linux'), 'linux');
		});
		test('BSD → linux bucket', () => {
			assert.strictEqual(detectNotificationPlatform('freebsd'), 'linux');
		});
		test('unknown → unknown', () => {
			assert.strictEqual(detectNotificationPlatform('haiku'), 'unknown');
		});
	});

	suite('urgencyToElectronOptions', () => {
		test('linux maps urgency directly', () => {
			assert.deepStrictEqual(urgencyToElectronOptions('critical', 'linux'), { urgency: 'critical' });
			assert.deepStrictEqual(urgencyToElectronOptions('low', 'linux'), { urgency: 'low' });
			assert.deepStrictEqual(urgencyToElectronOptions('normal', 'linux'), {});
		});
		test('non-linux: low → silent:true', () => {
			assert.deepStrictEqual(urgencyToElectronOptions('low', 'win32'), { silent: true });
			assert.deepStrictEqual(urgencyToElectronOptions('low', 'darwin'), { silent: true });
		});
		test('non-linux: normal/critical → no flags', () => {
			assert.deepStrictEqual(urgencyToElectronOptions('normal', 'win32'), {});
			assert.deepStrictEqual(urgencyToElectronOptions('critical', 'darwin'), {});
		});
	});
});
