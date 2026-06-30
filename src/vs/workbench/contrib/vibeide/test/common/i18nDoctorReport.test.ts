/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildI18nDoctorReport,
	formatI18nBadge,
	LocaleFreshnessSnapshot,
} from '../../common/i18nDoctorReport.js';

const DAY = 86_400_000;
const NOW = 1_750_000_000_000;

function snap(overrides: Partial<LocaleFreshnessSnapshot>): LocaleFreshnessSnapshot {
	return {
		localeTag: 'ru',
		translatedCount: 100,
		totalMetadataCount: 100,
		staleKeyCount: 0,
		...overrides,
	};
}

suite('i18n doctor report — pure aggregator + README badge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildI18nDoctorReport', () => {
		test('happy path — 100% coverage with recent sync', () => {
			const r = buildI18nDoctorReport({
				snapshots: [snap({ lastSyncAtMs: NOW - 2 * DAY })],
				nowMs: NOW,
			});
			assert.ok(r.markdown.includes('### i18n'));
			assert.ok(r.markdown.includes('**ru**'));
			assert.ok(r.markdown.includes('100.0%'));
			assert.ok(r.markdown.includes('синхр. 2 дня назад'));
			assert.strictEqual(r.perLocale[0].coveragePct, 100);
			assert.strictEqual(r.perLocale[0].daysSinceSync, 2);
		});

		test('no snapshots → "нет настроенных локалей"', () => {
			const r = buildI18nDoctorReport({ snapshots: [], nowMs: NOW });
			assert.ok(r.markdown.includes('нет настроенных локалей'));
			assert.deepStrictEqual(r.perLocale, []);
		});

		test('stale keys produce ✗ marker', () => {
			const r = buildI18nDoctorReport({
				snapshots: [snap({ staleKeyCount: 7 })],
				nowMs: NOW,
			});
			assert.ok(r.markdown.includes('✗'));
			assert.ok(r.markdown.includes('устаревшие: 7'));
		});

		test('no stale keys → ✓ marker', () => {
			const r = buildI18nDoctorReport({
				snapshots: [snap({ staleKeyCount: 0 })],
				nowMs: NOW,
			});
			assert.ok(r.markdown.includes('✓'));
			assert.ok(!r.markdown.includes('устаревшие'));
		});

		test('never synced → "не синхронизировано"', () => {
			const r = buildI18nDoctorReport({
				snapshots: [snap({ lastSyncAtMs: undefined })],
				nowMs: NOW,
			});
			assert.ok(r.markdown.includes('не синхронизировано'));
			assert.strictEqual(r.perLocale[0].daysSinceSync, null);
		});

		test('locales sorted alphabetically (de before ru)', () => {
			const r = buildI18nDoctorReport({
				snapshots: [
					snap({ localeTag: 'ru' }),
					snap({ localeTag: 'de' }),
				],
				nowMs: NOW,
			});
			assert.strictEqual(r.perLocale[0].localeTag, 'de');
			assert.strictEqual(r.perLocale[1].localeTag, 'ru');
		});

		test('coverage % computed correctly', () => {
			const r = buildI18nDoctorReport({
				snapshots: [snap({ translatedCount: 75, totalMetadataCount: 100 })],
				nowMs: NOW,
			});
			assert.strictEqual(r.perLocale[0].coveragePct, 75);
			assert.ok(r.markdown.includes('75.0%'));
		});

		test('zero metadata → 100% (vacuously true)', () => {
			const r = buildI18nDoctorReport({
				snapshots: [snap({ translatedCount: 0, totalMetadataCount: 0 })],
				nowMs: NOW,
			});
			assert.strictEqual(r.perLocale[0].coveragePct, 100);
		});

		test('daysSinceSync clamped to 0 if future timestamp (clock skew)', () => {
			const r = buildI18nDoctorReport({
				snapshots: [snap({ lastSyncAtMs: NOW + DAY })],
				nowMs: NOW,
			});
			assert.strictEqual(r.perLocale[0].daysSinceSync, 0);
		});

		test('slavic plural days: 1 → день, 2-4 → дня, 5+ → дней, 11-14 special', () => {
			const cases: Array<[number, string]> = [
				[1, 'день'],
				[2, 'дня'],
				[5, 'дней'],
				[11, 'дней'],
				[14, 'дней'],
				[21, 'день'],
				[22, 'дня'],
			];
			for (const [days, expected] of cases) {
				const r = buildI18nDoctorReport({
					snapshots: [snap({ lastSyncAtMs: NOW - days * DAY })],
					nowMs: NOW,
				});
				assert.ok(
					r.markdown.includes(`${days} ${expected}`),
					`expected "${days} ${expected}" in markdown for ${days} days`,
				);
			}
		});
	});

	suite('formatI18nBadge', () => {
		test('happy path — single locale', () => {
			const r = formatI18nBadge({
				snapshots: [snap({ localeTag: 'ru' })],
			});
			assert.strictEqual(r.text, 'i18n: ru 100%');
			assert.ok(r.shieldsUrl.startsWith('https://img.shields.io/badge/'));
			assert.ok(r.shieldsUrl.includes('brightgreen'));
		});

		test('multi-locale — alphabetical', () => {
			const r = formatI18nBadge({
				snapshots: [
					snap({ localeTag: 'ru', translatedCount: 100, totalMetadataCount: 100 }),
					snap({ localeTag: 'de', translatedCount: 50, totalMetadataCount: 100 }),
				],
			});
			assert.strictEqual(r.text, 'i18n: de 50% / ru 100%');
		});

		test('lowest coverage drives colour', () => {
			const r = formatI18nBadge({
				snapshots: [
					snap({ localeTag: 'a', translatedCount: 100, totalMetadataCount: 100 }),
					snap({ localeTag: 'b', translatedCount: 30, totalMetadataCount: 100 }),
				],
			});
			assert.ok(r.shieldsUrl.includes('orange'));
		});

		test('< 25% → red', () => {
			const r = formatI18nBadge({
				snapshots: [snap({ translatedCount: 10, totalMetadataCount: 100 })],
			});
			assert.ok(r.shieldsUrl.includes('red'));
		});

		test('coverage 95-100 → brightgreen', () => {
			const r = formatI18nBadge({
				snapshots: [snap({ translatedCount: 95, totalMetadataCount: 100 })],
			});
			assert.ok(r.shieldsUrl.includes('brightgreen'));
		});

		test('coverage 80-95 → green', () => {
			const r = formatI18nBadge({
				snapshots: [snap({ translatedCount: 85, totalMetadataCount: 100 })],
			});
			assert.ok(r.shieldsUrl.includes('green'));
			assert.ok(!r.shieldsUrl.includes('brightgreen'));
		});

		test('empty snapshots → нет данных + lightgrey', () => {
			const r = formatI18nBadge({ snapshots: [] });
			assert.ok(r.text.includes('нет данных'));
			assert.ok(r.shieldsUrl.includes('lightgrey'));
		});

		test('custom label', () => {
			const r = formatI18nBadge({
				snapshots: [snap({})],
				label: 'translation',
			});
			assert.ok(r.text.startsWith('translation:'));
		});

		test('rounding — 99.4 → 99', () => {
			const r = formatI18nBadge({
				snapshots: [snap({ translatedCount: 994, totalMetadataCount: 1000 })],
			});
			assert.ok(r.text.includes('99%'));
		});
	});
});
