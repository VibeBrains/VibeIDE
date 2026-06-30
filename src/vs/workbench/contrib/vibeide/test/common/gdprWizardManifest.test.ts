/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	buildGDPRExportManifest,
	buildGDPRDeleteManifest,
	describeGDPRExportConfirm,
	describeGDPRDeleteConfirm,
	countIrreversibleDeleteItems,
} from '../../common/gdprWizardManifest.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('gdprWizardManifest', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildGDPRExportManifest', () => {
		test('contains all six categories in stable order', () => {
			const m = buildGDPRExportManifest();
			assert.deepStrictEqual(m.map(x => x.category), [
				'audit-log',
				'settings',
				'vibe-artifacts',
				'chat-history',
				'byok-keys',
				'workspace-code',
			]);
		});

		test('workspace-code is the only excluded category', () => {
			const m = buildGDPRExportManifest();
			const excluded = m.filter(x => !x.included);
			assert.strictEqual(excluded.length, 1);
			assert.strictEqual(excluded[0].category, 'workspace-code');
		});

		test('every excluded item has a non-empty excludedReason', () => {
			const m = buildGDPRExportManifest();
			for (const item of m) {
				if (!item.included) {
					assert.ok(item.excludedReason && item.excludedReason.length > 0,
						`category ${item.category} excluded without reason`);
				}
			}
		});

		test('every included item has location and label', () => {
			const m = buildGDPRExportManifest();
			for (const item of m) {
				if (item.included) {
					assert.ok(item.label.length > 0);
					assert.ok(item.location.length > 0);
				}
			}
		});

		test('snapshot is deterministic across calls', () => {
			const a = buildGDPRExportManifest();
			const b = buildGDPRExportManifest();
			assert.deepStrictEqual(a, b);
		});
	});

	suite('buildGDPRDeleteManifest', () => {
		test('matches export categories in same order', () => {
			const exp = buildGDPRExportManifest();
			const del = buildGDPRDeleteManifest();
			assert.deepStrictEqual(
				exp.map(x => x.category),
				del.map(x => x.category),
			);
		});

		test('audit-log, vibe-artifacts, chat-history, byok-keys are irreversible', () => {
			const m = buildGDPRDeleteManifest();
			const irreversible = m.filter(x => x.irreversible).map(x => x.category).sort();
			assert.deepStrictEqual(irreversible, ['audit-log', 'byok-keys', 'chat-history', 'vibe-artifacts']);
		});

		test('settings is reversible (re-importable from backup)', () => {
			const m = buildGDPRDeleteManifest();
			const settings = m.find(x => x.category === 'settings');
			assert.strictEqual(settings?.irreversible, false);
		});

		test('workspace-code never deleted', () => {
			const m = buildGDPRDeleteManifest();
			const code = m.find(x => x.category === 'workspace-code');
			assert.strictEqual(code?.included, false);
			assert.strictEqual(code?.irreversible, false);
		});
	});

	suite('describeGDPRExportConfirm', () => {
		test('lists every included label', () => {
			const m = buildGDPRExportManifest();
			const text = describeGDPRExportConfirm(m);
			for (const it of m) {
				if (it.included) { assert.ok(text.includes(it.label), `missing label: ${it.label}`); }
			}
		});

		test('lists every excluded label with reason', () => {
			const m = buildGDPRExportManifest();
			const text = describeGDPRExportConfirm(m);
			for (const it of m) {
				if (!it.included) {
					assert.ok(text.includes(it.label));
					assert.ok(text.includes(it.excludedReason!));
				}
			}
		});

		test('mentions zip + SHA-256', () => {
			const text = describeGDPRExportConfirm(buildGDPRExportManifest());
			assert.match(text, /zip.*SHA-256/i);
		});
	});

	suite('describeGDPRDeleteConfirm', () => {
		test('flags irreversible items with [НЕОБРАТИМО]', () => {
			const m = buildGDPRDeleteManifest();
			const text = describeGDPRDeleteConfirm(m);
			const irrCount = m.filter(x => x.included && x.irreversible).length;
			const matches = text.match(/\[НЕОБРАТИМО\]/g) ?? [];
			assert.strictEqual(matches.length, irrCount);
		});

		test('settings appears WITHOUT the [НЕОБРАТИМО] tag', () => {
			const m = buildGDPRDeleteManifest();
			const text = describeGDPRDeleteConfirm(m);
			const settingsLine = text.split('\n').find(l => l.includes('Настройки VibeIDE'));
			assert.ok(settingsLine);
			assert.ok(!settingsLine!.includes('[НЕОБРАТИМО]'));
		});

		test('workspace code listed in "Останется на диске" section', () => {
			const m = buildGDPRDeleteManifest();
			const text = describeGDPRDeleteConfirm(m);
			assert.match(text, /Останется на диске/);
			assert.ok(text.includes('Исходный код проекта'));
		});
	});

	suite('countIrreversibleDeleteItems', () => {
		test('counts only included AND irreversible items', () => {
			const m = buildGDPRDeleteManifest();
			assert.strictEqual(countIrreversibleDeleteItems(m), 4);
		});

		test('returns 0 when all excluded', () => {
			const m = buildGDPRDeleteManifest().map(i => ({ ...i, included: false }));
			assert.strictEqual(countIrreversibleDeleteItems(m), 0);
		});
	});
});
