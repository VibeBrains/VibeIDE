/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * i18n doctor report — pure aggregator + README badge formatter
 * (roadmap §"Метрика «свежесть перевода»: в `vibe doctor` секция `i18n`
 * показывает % покрытия + дата последней синхронизации с Crowdin +
 * количество устаревших ключей" + §"README: бейдж `i18n: ru 100% / en 100%`").
 *
 * Pure helpers — `vscode`-free. Caller does the file IO; helper composes
 * the human-readable summary lines and the shields.io-compatible badge URL.
 */

export interface LocaleFreshnessSnapshot {
	readonly localeTag: string;
	readonly translatedCount: number;
	readonly totalMetadataCount: number;
	/** ms since epoch — most recent successful Crowdin sync; undefined when never. */
	readonly lastSyncAtMs?: number;
	/** Keys whose English source changed since the translation was last touched. */
	readonly staleKeyCount: number;
}

export interface DoctorI18nReportInput {
	readonly snapshots: ReadonlyArray<LocaleFreshnessSnapshot>;
	readonly nowMs: number;
}

export interface DoctorI18nReportResult {
	readonly markdown: string;
	readonly perLocale: ReadonlyArray<{
		readonly localeTag: string;
		readonly coveragePct: number;
		readonly staleKeyCount: number;
		readonly daysSinceSync: number | null;
	}>;
}

/**
 * Build the `vibe doctor --i18n` section markdown. Pure, deterministic.
 *
 *   - locales sorted alphabetically
 *   - coverage % rounded to 0.1
 *   - «sync N days ago» when a sync happened, «not synced» otherwise
 *   - bold ✗ marker when staleKeyCount > 0 (English moved, translation stale)
 */
export function buildI18nDoctorReport(input: DoctorI18nReportInput): DoctorI18nReportResult {
	const sorted = [...input.snapshots].sort((a, b) => a.localeTag.localeCompare(b.localeTag));
	const lines: string[] = [];
	lines.push('### i18n');
	const perLocale: DoctorI18nReportResult['perLocale'] = sorted.map(s => {
		const pct = computeCoveragePct(s);
		const days = daysSince(s.lastSyncAtMs, input.nowMs);
		const stale = s.staleKeyCount;
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

function computeCoveragePct(s: LocaleFreshnessSnapshot): number {
	if (s.totalMetadataCount <= 0) { return 100; }
	const ratio = s.translatedCount / s.totalMetadataCount;
	if (!Number.isFinite(ratio)) { return 0; }
	return Math.max(0, Math.min(100, ratio * 100));
}

function daysSince(thenMs: number | undefined, nowMs: number): number | null {
	if (typeof thenMs !== 'number' || !Number.isFinite(thenMs)) { return null; }
	const diff = nowMs - thenMs;
	if (diff < 0) { return 0; }
	return Math.floor(diff / 86_400_000);
}

function pluralDays(n: number): string {
	const last = n % 10;
	const lastTwo = n % 100;
	if (lastTwo >= 11 && lastTwo <= 14) { return 'дней'; }
	if (last === 1) { return 'день'; }
	if (last >= 2 && last <= 4) { return 'дня'; }
	return 'дней';
}

// -----------------------------------------------------------------------------
// README i18n badge (roadmap line 525)
// -----------------------------------------------------------------------------

export interface I18nBadgeInput {
	readonly snapshots: ReadonlyArray<LocaleFreshnessSnapshot>;
	/** Optional override of the badge label — default `i18n`. */
	readonly label?: string;
}

/**
 * Format the README badge text. Returns the human-readable badge fragment
 * (`i18n: ru 100% / en 100%`) plus a shields.io-compatible URL ready for
 * `<img src=...>`.
 *
 * Locales are sorted alphabetically so the badge stays stable across runs.
 * Coverage rounded to whole percent — fractional precision is noise in a
 * README badge.
 */
export function formatI18nBadge(input: I18nBadgeInput): { text: string; shieldsUrl: string } {
	const sorted = [...input.snapshots].sort((a, b) => a.localeTag.localeCompare(b.localeTag));
	const parts = sorted.map(s => `${s.localeTag} ${Math.round(computeCoveragePct(s))}%`);
	const label = input.label ?? 'i18n';
	const message = parts.length > 0 ? parts.join(' / ') : 'нет данных';
	const text = `${label}: ${message}`;
	const colour = pickShieldsColour(sorted);
	const safeLabel = encodeURIComponent(label);
	const safeMessage = encodeURIComponent(message);
	const shieldsUrl = `https://img.shields.io/badge/${safeLabel}-${safeMessage}-${colour}`;
	return { text, shieldsUrl };
}

function pickShieldsColour(snapshots: ReadonlyArray<LocaleFreshnessSnapshot>): string {
	if (snapshots.length === 0) { return 'lightgrey'; }
	let minPct = 100;
	for (const s of snapshots) {
		const pct = computeCoveragePct(s);
		if (pct < minPct) { minPct = pct; }
	}
	if (minPct >= 95) { return 'brightgreen'; }
	if (minPct >= 80) { return 'green'; }
	if (minPct >= 50) { return 'yellow'; }
	if (minPct >= 25) { return 'orange'; }
	return 'red';
}
