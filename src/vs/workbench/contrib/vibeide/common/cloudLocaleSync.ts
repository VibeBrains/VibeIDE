/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeIDE Cloud locale sync — pure decision helper
 * (roadmap §"Pack VSIX → Локаль из VibeIDE Cloud (если будет, Phase 3b+):
 * синхронизация выбора языка через `vibe sync` — пользователь меняет на
 * одной машине, остальные подхватывают").
 *
 * Pure helper — `vscode`-free. The cloud sync runtime calls this to decide
 * what to do when local and remote locale settings disagree. Without a
 * decision helper the sync UI would constantly oscillate between machines.
 */

export type LocaleSyncDecision =
	| { readonly kind: 'no-op'; readonly reason: 'no-remote' | 'identical' | 'cloud-disabled' }
	| { readonly kind: 'apply-remote'; readonly remoteLocale: string; readonly reason: 'remote-newer' | 'first-pull' }
	| { readonly kind: 'push-local'; readonly localLocale: string; readonly reason: 'local-newer' | 'first-push' }
	| { readonly kind: 'conflict'; readonly localLocale: string; readonly remoteLocale: string; readonly reason: 'concurrent-change' };

export interface LocaleSyncInput {
	readonly cloudEnabled: boolean;
	readonly localLocale: string;
	readonly remoteLocale: string | null;
	readonly localUpdatedAtMs: number | null;
	readonly remoteUpdatedAtMs: number | null;
	readonly lastSyncedLocale: string | null;
	/** Tolerance window for "concurrent-change" — default 5s clock skew. */
	readonly concurrencyToleranceMs?: number;
}

const DEFAULT_TOLERANCE_MS = 5_000;

/**
 * Decide what `vibe sync` should do for the locale setting. Pure.
 *
 *   - cloudEnabled === false     → 'no-op: cloud-disabled'
 *   - remote = null              → 'push-local: first-push' (only if local set)
 *   - local & remote identical   → 'no-op: identical'
 *   - never synced before        → use timestamps; equal → 'apply-remote: first-pull'
 *   - timestamps within tolerance → 'conflict: concurrent-change'
 *   - remote newer               → 'apply-remote: remote-newer'
 *   - local newer                → 'push-local: local-newer'
 *
 * `lastSyncedLocale` is consulted for the conflict-detection: if both
 * sides changed since the last sync (each differs from `lastSyncedLocale`)
 * AND timestamps are within tolerance, we surface a conflict.
 */
export function decideLocaleSync(input: LocaleSyncInput): LocaleSyncDecision {
	if (!input.cloudEnabled) {
		return { kind: 'no-op', reason: 'cloud-disabled' };
	}

	const local = normaliseLocale(input.localLocale);
	const remote = input.remoteLocale === null ? null : normaliseLocale(input.remoteLocale);

	if (remote === null) {
		if (local.length === 0) {
			return { kind: 'no-op', reason: 'no-remote' };
		}
		return { kind: 'push-local', localLocale: local, reason: 'first-push' };
	}

	if (local === remote) {
		return { kind: 'no-op', reason: 'identical' };
	}

	if (input.lastSyncedLocale === null) {
		// Never synced before. Treat remote as canonical on first pull —
		// fewer surprise overwrites than "newer wins" when timestamps were
		// captured with different clocks.
		return { kind: 'apply-remote', remoteLocale: remote, reason: 'first-pull' };
	}

	const lastSynced = normaliseLocale(input.lastSyncedLocale);
	const localChanged = local !== lastSynced;
	const remoteChanged = remote !== lastSynced;

	if (localChanged && remoteChanged) {
		const tolerance = typeof input.concurrencyToleranceMs === 'number' && Number.isFinite(input.concurrencyToleranceMs) && input.concurrencyToleranceMs >= 0
			? input.concurrencyToleranceMs
			: DEFAULT_TOLERANCE_MS;
		const localT = input.localUpdatedAtMs ?? 0;
		const remoteT = input.remoteUpdatedAtMs ?? 0;
		const skew = Math.abs(localT - remoteT);
		if (skew <= tolerance) {
			return {
				kind: 'conflict',
				localLocale: local,
				remoteLocale: remote,
				reason: 'concurrent-change',
			};
		}
		if (localT > remoteT) {
			return { kind: 'push-local', localLocale: local, reason: 'local-newer' };
		}
		return { kind: 'apply-remote', remoteLocale: remote, reason: 'remote-newer' };
	}

	if (remoteChanged) {
		return { kind: 'apply-remote', remoteLocale: remote, reason: 'remote-newer' };
	}
	// localChanged
	return { kind: 'push-local', localLocale: local, reason: 'local-newer' };
}

function normaliseLocale(s: string): string {
	if (typeof s !== 'string') { return ''; }
	return s.trim().toLowerCase().replace(/_/g, '-');
}

/**
 * RU one-line description for the `vibe sync` UI confirm. Pure.
 */
export function describeLocaleSyncDecision(d: LocaleSyncDecision): string {
	switch (d.kind) {
		case 'no-op':
			return d.reason === 'cloud-disabled'
				? 'Cloud-синхронизация отключена.'
				: d.reason === 'identical'
					? 'Локаль совпадает с облачной — изменений нет.'
					: 'Локаль ещё не задана.';
		case 'apply-remote':
			return d.reason === 'first-pull'
				? `Применить локаль из облака: ${d.remoteLocale}`
				: `Локаль изменилась в облаке: ${d.remoteLocale}`;
		case 'push-local':
			return d.reason === 'first-push'
				? `Отправить локаль ${d.localLocale} в облако (первая синхронизация).`
				: `Отправить локаль ${d.localLocale} в облако.`;
		case 'conflict':
			return `Конфликт: локально «${d.localLocale}», в облаке «${d.remoteLocale}». Выберите вручную.`;
	}
}
