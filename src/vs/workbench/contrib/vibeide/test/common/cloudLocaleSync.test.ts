/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decideLocaleSync,
	describeLocaleSyncDecision,
	LocaleSyncInput,
} from '../../common/cloudLocaleSync.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function input(overrides: Partial<LocaleSyncInput> = {}): LocaleSyncInput {
	return {
		cloudEnabled: true,
		localLocale: 'ru',
		remoteLocale: 'ru',
		localUpdatedAtMs: 1000,
		remoteUpdatedAtMs: 1000,
		lastSyncedLocale: 'ru',
		...overrides,
	};
}

suite('VibeIDE Cloud locale sync — decision helper', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideLocaleSync', () => {
		test('cloud disabled → no-op:cloud-disabled', () => {
			const r = decideLocaleSync(input({ cloudEnabled: false }));
			assert.strictEqual(r.kind, 'no-op');
			if (r.kind === 'no-op') { assert.strictEqual(r.reason, 'cloud-disabled'); }
		});

		test('identical → no-op:identical', () => {
			const r = decideLocaleSync(input());
			assert.strictEqual(r.kind, 'no-op');
			if (r.kind === 'no-op') { assert.strictEqual(r.reason, 'identical'); }
		});

		test('no remote + local set → push-local:first-push', () => {
			const r = decideLocaleSync(input({ remoteLocale: null }));
			assert.strictEqual(r.kind, 'push-local');
			if (r.kind === 'push-local') { assert.strictEqual(r.reason, 'first-push'); }
		});

		test('no remote + no local → no-op:no-remote', () => {
			const r = decideLocaleSync(input({ remoteLocale: null, localLocale: '' }));
			assert.strictEqual(r.kind, 'no-op');
			if (r.kind === 'no-op') { assert.strictEqual(r.reason, 'no-remote'); }
		});

		test('first sync ever → apply-remote:first-pull', () => {
			const r = decideLocaleSync(input({
				localLocale: 'ru',
				remoteLocale: 'de',
				lastSyncedLocale: null,
			}));
			assert.strictEqual(r.kind, 'apply-remote');
			if (r.kind === 'apply-remote') { assert.strictEqual(r.reason, 'first-pull'); }
		});

		test('only remote changed → apply-remote:remote-newer', () => {
			const r = decideLocaleSync(input({
				localLocale: 'ru',
				remoteLocale: 'de',
				lastSyncedLocale: 'ru',
			}));
			assert.strictEqual(r.kind, 'apply-remote');
			if (r.kind === 'apply-remote') { assert.strictEqual(r.reason, 'remote-newer'); }
		});

		test('only local changed → push-local:local-newer', () => {
			const r = decideLocaleSync(input({
				localLocale: 'de',
				remoteLocale: 'ru',
				lastSyncedLocale: 'ru',
			}));
			assert.strictEqual(r.kind, 'push-local');
		});

		test('both changed within tolerance → conflict:concurrent-change', () => {
			const r = decideLocaleSync(input({
				localLocale: 'de',
				remoteLocale: 'fr',
				lastSyncedLocale: 'ru',
				localUpdatedAtMs: 10_000,
				remoteUpdatedAtMs: 11_000,
			}));
			assert.strictEqual(r.kind, 'conflict');
			if (r.kind === 'conflict') {
				assert.strictEqual(r.localLocale, 'de');
				assert.strictEqual(r.remoteLocale, 'fr');
			}
		});

		test('both changed beyond tolerance → newer wins', () => {
			const r = decideLocaleSync(input({
				localLocale: 'de',
				remoteLocale: 'fr',
				lastSyncedLocale: 'ru',
				localUpdatedAtMs: 1_000,
				remoteUpdatedAtMs: 100_000,
			}));
			assert.strictEqual(r.kind, 'apply-remote');
			if (r.kind === 'apply-remote') { assert.strictEqual(r.reason, 'remote-newer'); }
		});

		test('custom tolerance respected', () => {
			const r = decideLocaleSync(input({
				localLocale: 'de',
				remoteLocale: 'fr',
				lastSyncedLocale: 'ru',
				localUpdatedAtMs: 10_000,
				remoteUpdatedAtMs: 12_000,
				concurrencyToleranceMs: 100,
			}));
			// 2000ms gap > 100ms tolerance → not a conflict, newer wins
			assert.notStrictEqual(r.kind, 'conflict');
		});

		test('local newer beyond tolerance', () => {
			const r = decideLocaleSync(input({
				localLocale: 'de',
				remoteLocale: 'fr',
				lastSyncedLocale: 'ru',
				localUpdatedAtMs: 100_000,
				remoteUpdatedAtMs: 10_000,
			}));
			assert.strictEqual(r.kind, 'push-local');
		});

		test('locale normalised (RU_BY → ru-by)', () => {
			const r = decideLocaleSync(input({
				localLocale: 'RU_BY',
				remoteLocale: 'ru-by',
				lastSyncedLocale: 'ru-by',
			}));
			assert.strictEqual(r.kind, 'no-op');
		});

		test('whitespace trimmed in locale', () => {
			const r = decideLocaleSync(input({
				localLocale: '  ru  ',
				remoteLocale: 'ru',
				lastSyncedLocale: 'ru',
			}));
			assert.strictEqual(r.kind, 'no-op');
		});

		test('non-finite tolerance falls back to default', () => {
			const r = decideLocaleSync(input({
				localLocale: 'de',
				remoteLocale: 'fr',
				lastSyncedLocale: 'ru',
				localUpdatedAtMs: 10_000,
				remoteUpdatedAtMs: 11_000,
				concurrencyToleranceMs: NaN,
			}));
			// NaN → default 5s; 1s < 5s → conflict
			assert.strictEqual(r.kind, 'conflict');
		});
	});

	suite('describeLocaleSyncDecision', () => {
		test('no-op:cloud-disabled', () => {
			const s = describeLocaleSyncDecision({ kind: 'no-op', reason: 'cloud-disabled' });
			assert.ok(s.includes('отключена'));
		});

		test('apply-remote:remote-newer', () => {
			const s = describeLocaleSyncDecision({ kind: 'apply-remote', remoteLocale: 'de', reason: 'remote-newer' });
			assert.ok(s.includes('de'));
			assert.ok(s.toLowerCase().includes('изменилась'));
		});

		test('apply-remote:first-pull', () => {
			const s = describeLocaleSyncDecision({ kind: 'apply-remote', remoteLocale: 'de', reason: 'first-pull' });
			assert.ok(s.toLowerCase().includes('применить'));
		});

		test('push-local:first-push', () => {
			const s = describeLocaleSyncDecision({ kind: 'push-local', localLocale: 'ru', reason: 'first-push' });
			assert.ok(s.includes('ru'));
		});

		test('conflict body lists both locales', () => {
			const s = describeLocaleSyncDecision({
				kind: 'conflict',
				localLocale: 'de',
				remoteLocale: 'fr',
				reason: 'concurrent-change',
			});
			assert.ok(s.includes('de'));
			assert.ok(s.includes('fr'));
		});
	});
});
