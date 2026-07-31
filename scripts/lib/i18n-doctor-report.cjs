/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CJS port of `common/i18nDoctorReport.ts` for `vibe doctor --i18n` freshness section.
// MUST stay in sync with that TS file (buildI18nDoctorReport + formatI18nBadge semantics
// + slavic-plural rule + clock-skew clamp + alphabetical sort).

'use strict';

function computeCoveragePct(s) {
	if (!s || !Number.isFinite(s.totalMetadataCount) || s.totalMetadataCount <= 0) {return 100;}
	const ratio = s.translatedCount / s.totalMetadataCount;
	if (!Number.isFinite(ratio)) {return 0;}
	return Math.max(0, Math.min(100, ratio * 100));
}

function daysSince(thenMs, nowMs) {
	if (typeof thenMs !== 'number' || !Number.isFinite(thenMs)) {return null;}
	const diff = nowMs - thenMs;
	if (diff < 0) {return 0;}
	return Math.floor(diff / 86_400_000);
}

function pluralDays(n) {
	const last = n % 10;
	const lastTwo = n % 100;
	if (lastTwo >= 11 && lastTwo <= 14) {return 'дней';}
	if (last === 1) {return 'день';}
	if (last >= 2 && last <= 4) {return 'дня';}
	return 'дней';
}

function buildI18nDoctorReport(input) {
	const snapshots = Array.isArray(input?.snapshots) ? input.snapshots : [];
	const nowMs = typeof input?.nowMs === 'number' ? input.nowMs : Date.now();
	const sorted = snapshots.slice().sort((a, b) => String(a.localeTag).localeCompare(String(b.localeTag)));

	const lines = ['### i18n'];
	const perLocale = sorted.map((s) => {
		const pct = computeCoveragePct(s);
		const days = daysSince(s.lastSyncAtMs, nowMs);
		const stale = Number.isFinite(s.staleKeyCount) ? s.staleKeyCount : 0;
		const flag = stale > 0 ? '✗ ' : '✓ ';
		const syncLabel = days === null ? 'не синхронизировано' : `синхр. ${days} ${pluralDays(days)} назад`;
		const staleLabel = stale > 0 ? `, устаревшие: ${stale}` : '';
		lines.push(`${flag}**${s.localeTag}** — ${pct.toFixed(1)}% покрытия (${syncLabel}${staleLabel})`);
		return {
			localeTag: s.localeTag,
			coveragePct: pct,
			staleKeyCount: stale,
			daysSinceSync: days,
		};
	});
	if (sorted.length === 0) {
		lines.push('_нет настроенных локалей_');
	}
	return { markdown: lines.join('\n'), perLocale };
}

function pickShieldsColour(snapshots) {
	if (snapshots.length === 0) {return 'lightgrey';}
	let minPct = 100;
	for (const s of snapshots) {
		const pct = computeCoveragePct(s);
		if (pct < minPct) {minPct = pct;}
	}
	if (minPct >= 95) {return 'brightgreen';}
	if (minPct >= 80) {return 'green';}
	if (minPct >= 50) {return 'yellow';}
	if (minPct >= 25) {return 'orange';}
	return 'red';
}

function formatI18nBadge(input) {
	const snapshots = Array.isArray(input?.snapshots) ? input.snapshots : [];
	const sorted = snapshots.slice().sort((a, b) => String(a.localeTag).localeCompare(String(b.localeTag)));
	const parts = sorted.map((s) => `${s.localeTag} ${Math.round(computeCoveragePct(s))}%`);
	const label = typeof input?.label === 'string' && input.label.length > 0 ? input.label : 'i18n';
	const message = parts.length > 0 ? parts.join(' / ') : 'нет данных';
	const text = `${label}: ${message}`;
	const colour = pickShieldsColour(sorted);
	const safeLabel = encodeURIComponent(label);
	const safeMessage = encodeURIComponent(message);
	const shieldsUrl = `https://img.shields.io/badge/${safeLabel}-${safeMessage}-${colour}`;
	return { text, shieldsUrl };
}

module.exports = { buildI18nDoctorReport, formatI18nBadge };

// ──────────────────────────────────────────────────────────
// Self-tests — `node scripts/lib/i18n-doctor-report.cjs`
// ──────────────────────────────────────────────────────────

if (require.main === module) {
	const assert = require('node:assert');

	// Empty input.
	{
		const r = buildI18nDoctorReport({ snapshots: [], nowMs: 0 });
		assert.ok(r.markdown.includes('нет настроенных локалей'), 'empty input message');
		assert.strictEqual(r.perLocale.length, 0);
	}

	// Coverage rounding + ✓/✗ flags + slavic plural.
	{
		const now = 10 * 86_400_000;
		const r = buildI18nDoctorReport({
			nowMs: now,
			snapshots: [
				{ localeTag: 'ru', translatedCount: 95, totalMetadataCount: 100, lastSyncAtMs: now - 86_400_000, staleKeyCount: 0 },
				{ localeTag: 'en', translatedCount: 100, totalMetadataCount: 100, lastSyncAtMs: now - 2 * 86_400_000, staleKeyCount: 3 },
			],
		});
		// Alphabetical: en first.
		assert.ok(r.markdown.indexOf('**en**') < r.markdown.indexOf('**ru**'), 'alphabetical');
		assert.ok(r.markdown.includes('✗ **en**'), 'stale flag');
		assert.ok(r.markdown.includes('✓ **ru**'), 'fresh flag');
		assert.ok(r.markdown.includes('синхр. 1 день назад'), 'plural 1');
		assert.ok(r.markdown.includes('синхр. 2 дня назад'), 'plural 2-4');
		assert.ok(r.markdown.includes('устаревшие: 3'), 'stale count');
	}

	// Plural 11-14 → дней, 5+ → дней.
	{
		const now = 100 * 86_400_000;
		const r = buildI18nDoctorReport({
			nowMs: now,
			snapshots: [
				{ localeTag: 'a', translatedCount: 1, totalMetadataCount: 1, lastSyncAtMs: now - 11 * 86_400_000, staleKeyCount: 0 },
				{ localeTag: 'b', translatedCount: 1, totalMetadataCount: 1, lastSyncAtMs: now - 5 * 86_400_000, staleKeyCount: 0 },
				{ localeTag: 'c', translatedCount: 1, totalMetadataCount: 1, lastSyncAtMs: now - 21 * 86_400_000, staleKeyCount: 0 },
			],
		});
		assert.ok(r.markdown.includes('синхр. 11 дней назад'), 'plural 11');
		assert.ok(r.markdown.includes('синхр. 5 дней назад'), 'plural 5');
		assert.ok(r.markdown.includes('синхр. 21 день назад'), 'plural 21');
	}

	// Clock skew: future timestamp clamps to 0.
	{
		const r = buildI18nDoctorReport({
			nowMs: 1000,
			snapshots: [{ localeTag: 'x', translatedCount: 1, totalMetadataCount: 1, lastSyncAtMs: 5000, staleKeyCount: 0 }],
		});
		assert.ok(r.markdown.includes('синхр. 0 дней назад'), 'future clamps to 0');
	}

	// Never synced.
	{
		const r = buildI18nDoctorReport({
			nowMs: 0,
			snapshots: [{ localeTag: 'fr', translatedCount: 0, totalMetadataCount: 10, staleKeyCount: 0 }],
		});
		assert.ok(r.markdown.includes('не синхронизировано'), 'never synced');
	}

	// Badge: shields colour by lowest coverage.
	{
		const b = formatI18nBadge({
			snapshots: [
				{ localeTag: 'ru', translatedCount: 100, totalMetadataCount: 100, staleKeyCount: 0 },
				{ localeTag: 'en', translatedCount: 80, totalMetadataCount: 100, staleKeyCount: 0 },
			],
		});
		assert.ok(b.text === 'i18n: en 80% / ru 100%', `badge text: ${b.text}`);
		assert.ok(b.shieldsUrl.endsWith('-green'), `badge colour: ${b.shieldsUrl}`);
	}

	// Badge: empty → lightgrey.
	{
		const b = formatI18nBadge({ snapshots: [] });
		assert.ok(b.shieldsUrl.endsWith('-lightgrey'), `empty colour: ${b.shieldsUrl}`);
		assert.ok(b.text.includes('нет данных'), 'empty text');
	}

	console.log('i18n-doctor-report.cjs: self-tests OK');
}
