/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `FORK_CHANGES.md` entry formatter + dedup
 * (roadmap §"Project Commands → Обновить `FORK_CHANGES.md` после реализации
 * MVP" + §"K.1 — `FORK_CHANGES.md` авто-обновление через CI" (item already
 * shipped at `73e86418`)).
 *
 * Pure helpers — `vscode`-free. The fork-changes CI workflow appends an
 * entry per `fork-change`-labelled merged PR; this module shapes the entry
 * format and de-duplicates by PR number so re-runs don't double-write.
 */

const PR_REF_PATTERN = /^(#?\d+|[a-z0-9-]+\/[a-z0-9-]+#\d+)$/i;
const SERVICE_NAME_PATTERN = /^[A-Z][A-Za-z0-9_-]{0,63}$/;

export interface ForkChangeEntry {
	readonly date: string;
	readonly service: string;
	readonly summary: string;
	readonly prRef?: string;
}

export type DecodeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

/**
 * Validate + normalise a fork-change entry. Date must be ISO-8601 yyyy-MM-dd.
 * Service is a CamelCase / PascalCase name (e.g. `VibeMCPOAuthService`).
 * Summary is the PR title. PR ref is optional but, if present, must match
 * the documented form `#NNN` or `org/repo#NNN`.
 */
export function decodeForkChangeEntry(raw: unknown): DecodeResult<ForkChangeEntry> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-an-object' }; }
	const o = raw as Record<string, unknown>;
	if (typeof o.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) {
		return { ok: false, reason: 'date-malformed' };
	}
	if (typeof o.service !== 'string' || !SERVICE_NAME_PATTERN.test(o.service)) {
		return { ok: false, reason: 'service-malformed' };
	}
	if (typeof o.summary !== 'string' || o.summary.trim().length === 0) {
		return { ok: false, reason: 'summary-empty' };
	}
	if (o.summary.length > 200) {
		return { ok: false, reason: 'summary-too-long' };
	}
	let prRef: string | undefined;
	if (o.prRef !== undefined && o.prRef !== null) {
		if (typeof o.prRef !== 'string' || !PR_REF_PATTERN.test(o.prRef)) {
			return { ok: false, reason: 'prRef-malformed' };
		}
		prRef = o.prRef;
	}
	return {
		ok: true,
		value: {
			date: o.date,
			service: o.service,
			summary: o.summary.trim(),
			...(prRef !== undefined ? { prRef } : {}),
		},
	};
}

/**
 * Render a single fork-change entry as the on-disk markdown line. Pure.
 *   `- date: 2026-05-08 | service: VibeIDEFoo | summary: Add bar (#123)`
 */
export function formatForkChangeLine(entry: ForkChangeEntry): string {
	const tail = entry.prRef ? ` (${formatPrRef(entry.prRef)})` : '';
	return `- date: ${entry.date} | service: ${entry.service} | summary: ${entry.summary}${tail}`;
}

function formatPrRef(ref: string): string {
	const trimmed = ref.trim();
	if (/^\d+$/.test(trimmed)) { return `#${trimmed}`; }
	return trimmed;
}

/**
 * Dedupe a list of entries by `prRef` (when present) or by composite
 * `date|service|summary` (when not). First occurrence wins. Pure.
 */
export function dedupeForkChangeEntries(entries: ReadonlyArray<ForkChangeEntry>): readonly ForkChangeEntry[] {
	const seen = new Set<string>();
	const out: ForkChangeEntry[] = [];
	for (const e of entries) {
		const key = e.prRef !== undefined ? `pr:${normalisePrRef(e.prRef)}` : `s:${e.date}|${e.service}|${e.summary}`;
		if (seen.has(key)) { continue; }
		seen.add(key);
		out.push(e);
	}
	return out;
}

function normalisePrRef(ref: string): string {
	const trimmed = ref.trim();
	if (/^\d+$/.test(trimmed)) { return `#${trimmed}`; }
	return trimmed.toLowerCase();
}

/**
 * Decide whether a candidate entry should be appended to the existing
 * `FORK_CHANGES.md` content. Pure — caller passes the raw markdown text.
 *
 *   - already-present (PR ref or composite key match) → 'skip'
 *   - empty / whitespace-only candidate → 'reject'
 *   - otherwise → 'append'
 */
export function decideForkChangeAppend(
	candidate: ForkChangeEntry,
	existingMarkdown: string,
): { readonly action: 'append'; readonly line: string } | { readonly action: 'skip'; readonly reason: 'duplicate-pr' | 'duplicate-key' } | { readonly action: 'reject'; readonly reason: 'empty-summary' } {
	if (candidate.summary.trim().length === 0) {
		return { action: 'reject', reason: 'empty-summary' };
	}
	if (candidate.prRef !== undefined) {
		const ref = formatPrRef(candidate.prRef);
		if (existingMarkdown.includes(`(${ref})`)) {
			return { action: 'skip', reason: 'duplicate-pr' };
		}
	}
	const key = `service: ${candidate.service} | summary: ${candidate.summary}`;
	const dateKey = `date: ${candidate.date} | ${key}`;
	if (existingMarkdown.includes(dateKey)) {
		return { action: 'skip', reason: 'duplicate-key' };
	}
	return { action: 'append', line: formatForkChangeLine(candidate) };
}
