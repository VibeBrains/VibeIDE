/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a subscription has left, as the VENDOR reports it — never computed by us.
 *
 * A plan's credits are recounted by the vendor's own rules (multipliers per model, peak hours), and usage made outside
 * the IDE with the same key is invisible here; a counter of ours would be a guess dressed as a number. So the IDE asks
 * the endpoint named in the provider's `quota` field and shows its answer, and anything it cannot read for certain is
 * «no data», never 0.
 *
 * The reading rules are VibeIDEA's (`SubscriptionQuota.kt`), and both products check them against the same vectors in
 * the shared set (`testVectors/subscriptionQuota.json`): one vendor answer must read the same in both.
 *
 * Pure: a response body in, windows out. The request is made in the main process, where the key is known.
 */

/** MiniMax Token Plan, `GET …/v1/token_plan/remains` (platform.minimax.io/docs/token-plan/faq). */
export const MINIMAX_TOKEN_PLAN = 'minimax-token-plan';
/** Z.ai GLM Coding Plan, `GET https://api.z.ai/api/monitor/usage/quota/limit` — not documented by the vendor. */
export const ZAI_MONITOR = 'zai-monitor';
export const QUOTA_FORMATS: readonly string[] = [MINIMAX_TOKEN_PLAN, ZAI_MONITOR];

export interface QuotaSpec {
	readonly url: string;
	readonly format: string;
}

/**
 * The provider's `quota` field: absent, valid, or `'invalid'` (unknown format, a URL that is not https) — the caller
 * names the invalid one aloud. The request carries the API key, so plain http is refused outright.
 */
export function parseQuotaSpec(raw: unknown): QuotaSpec | undefined | 'invalid' {
	if (raw === undefined) {
		return undefined;
	}
	const record = raw && typeof raw === 'object' ? raw as { url?: unknown; format?: unknown } : undefined;
	const url = typeof record?.url === 'string' ? record.url.trim() : '';
	const format = typeof record?.format === 'string' ? record.format : '';
	if (!url.startsWith('https://') || !QUOTA_FORMATS.includes(format)) {
		return 'invalid';
	}
	return { url, format };
}

/**
 * One window of the plan. `scope` — what it limits as the vendor names it (a model family, `MCP`), null for the plan
 * as a whole; `windowMs` null — unknown length; `leftPercent` null — unlimited, above 100 — a vendor boost.
 */
export interface QuotaWindow {
	readonly scope: string | null;
	readonly windowMs: number | null;
	readonly leftPercent: number | null;
	readonly resetAtMs: number | null;
}

export type QuotaResult =
	| { readonly kind: 'windows'; readonly windows: readonly QuotaWindow[] }
	/** The vendor answered with an error of its own. */
	| { readonly kind: 'vendorError'; readonly message: string }
	/** The answer could not be read for certain — an unknown shape, or nothing in it. */
	| { readonly kind: 'unreadable' };

type JsonRecord = Record<string, unknown>;

function recordOf(value: unknown): JsonRecord | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function numberOf(record: JsonRecord | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function textOf(record: JsonRecord | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

const UNREADABLE: QuotaResult = { kind: 'unreadable' };

export function parseSubscriptionQuota(format: string, body: string): QuotaResult {
	let root: JsonRecord | undefined;
	try {
		root = recordOf(JSON.parse(body));
	} catch {
		return UNREADABLE;
	}
	if (!root) {
		return UNREADABLE;
	}
	switch (format) {
		case MINIMAX_TOKEN_PLAN: return minimax(root);
		case ZAI_MONITOR: return zai(root);
		default: return UNREADABLE;
	}
}

// --- MiniMax ---

/** `*_status` of the vendor: 3 — unlimited (and, with zero totals on both windows, not in the plan at all). */
const MINIMAX_UNLIMITED = 3;
/** A count and a percentage that disagree by more than this are not trusted either way (the vendor CLI's tolerance). */
const PERCENT_TOLERANCE = 1.0;
const PERMILLE = 1000;

function minimax(root: JsonRecord): QuotaResult {
	const base = recordOf(root.base_resp);
	const code = numberOf(base, 'status_code');
	if (code !== undefined && code !== 0) {
		return { kind: 'vendorError', message: textOf(base, 'status_msg') ?? `status_code ${code}` };
	}
	if (!Array.isArray(root.model_remains)) {
		return UNREADABLE;
	}
	const windows: QuotaWindow[] = [];
	for (const item of root.model_remains) {
		const model = recordOf(item);
		if (!model) {
			continue;
		}
		const scope = textOf(model, 'model_name') ?? null;
		const intervalTotal = numberOf(model, 'current_interval_total_count');
		const weeklyTotal = numberOf(model, 'current_weekly_total_count');
		const intervalStatus = numberOf(model, 'current_interval_status');
		const weeklyStatus = numberOf(model, 'current_weekly_status');
		// Both windows «unlimited» with nothing in them is how the API marks a model outside the plan (vendor CLI #173).
		if (intervalTotal === 0 && weeklyTotal === 0 && intervalStatus === MINIMAX_UNLIMITED && weeklyStatus === MINIMAX_UNLIMITED) {
			continue;
		}
		const interval = minimaxWindow(scope, model, 'start_time', 'end_time', intervalTotal, 'current_interval_usage_count', 'current_interval_remaining_percent', intervalStatus, 1);
		const weeklyBoost = Math.max(0, numberOf(model, 'weekly_boost_permille') ?? PERMILLE) / PERMILLE;
		const weekly = minimaxWindow(scope, model, 'weekly_start_time', 'weekly_end_time', weeklyTotal, 'current_weekly_usage_count', 'current_weekly_remaining_percent', weeklyStatus, weeklyBoost);
		if (interval) { windows.push(interval); }
		if (weekly) { windows.push(weekly); }
	}
	return windows.length > 0 ? { kind: 'windows', windows } : UNREADABLE;
}

function minimaxWindow(scope: string | null, model: JsonRecord, startKey: string, endKey: string, total: number | undefined, countKey: string, percentKey: string, status: number | undefined, boost: number): QuotaWindow | undefined {
	const start = numberOf(model, startKey);
	const end = numberOf(model, endKey);
	const span = start !== undefined && end !== undefined && end > start ? end - start : null;
	if (status === MINIMAX_UNLIMITED) {
		return { scope, windowMs: span, leftPercent: null, resetAtMs: end ?? null };
	}
	// A window with no total is not part of this plan (the weekly one of a text model, in the vendor's own fixture).
	if (total === undefined || total <= 0) {
		return undefined;
	}
	const left = leftShare(numberOf(model, countKey), total, numberOf(model, percentKey));
	if (left === null) {
		return undefined;
	}
	return { scope, windowMs: span, leftPercent: Math.round(left * 100 * boost), resetAtMs: end ?? null };
}

/**
 * The share left, from `*_usage_count`, whose meaning the vendor itself changed: older answers put what is LEFT in it,
 * newer ones may put what is USED. With the vendor's remaining percentage beside it, the reading that agrees with the
 * percentage wins; if neither agrees, nothing is shown. Without a percentage the older reading holds — as in the
 * vendor's CLI (`resolveQuotaCounts`), the only authority on this field there is.
 */
export function leftShare(count: number | undefined | null, total: number, remainingPercent: number | undefined | null): number | null {
	if (count === undefined || count === null || count < 0 || count > total || total <= 0) {
		return null;
	}
	if (remainingPercent === undefined || remainingPercent === null) {
		return count / total;
	}
	const leftDistance = Math.abs(count / total * 100 - remainingPercent);
	const usedDistance = Math.abs((total - count) / total * 100 - remainingPercent);
	if (Math.min(leftDistance, usedDistance) > PERCENT_TOLERANCE) {
		return null;
	}
	return usedDistance < leftDistance ? (total - count) / total : count / total;
}

// --- Z.ai ---

const ZAI_OK = 200;
/** Limit types that carry the plan's windows: tokens before September 2026, credits since (onWatch#122). */
const ZAI_PLAN_TYPES = ['TOKENS_LIMIT', 'CREDIT_LIMIT'];
/** The MCP tools' monthly allowance — a window of its own, never the plan's. */
const ZAI_MCP_TYPE = 'TIME_LIMIT';
export const ZAI_MCP_SCOPE = 'MCP';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** `unit` of a limit → its length; 6 as a week is inferred from the raw answer in onWatch#122. */
const ZAI_UNIT_MS: Readonly<Record<number, number>> = { 5: MINUTE_MS, 3: HOUR_MS, 1: DAY_MS, 6: 7 * DAY_MS };

function zai(root: JsonRecord): QuotaResult {
	const success = typeof root.success === 'boolean' ? root.success : undefined;
	const code = numberOf(root, 'code');
	if (success !== true || code !== ZAI_OK) {
		return success === undefined && code === undefined ? UNREADABLE : { kind: 'vendorError', message: textOf(root, 'msg') ?? `code ${code ?? 'null'}` };
	}
	const limits = recordOf(root.data)?.limits;
	if (!Array.isArray(limits)) {
		return UNREADABLE;
	}
	const windows: QuotaWindow[] = [];
	for (const item of limits) {
		const limit = recordOf(item);
		const type = textOf(limit, 'type');
		const scope = type !== undefined && ZAI_PLAN_TYPES.includes(type) ? null : type === ZAI_MCP_TYPE ? ZAI_MCP_SCOPE : undefined;
		if (scope === undefined) {
			continue;
		}
		// The percentage is USED, an integer; without it the limit says nothing we may show.
		const used = numberOf(limit, 'percentage');
		if (used === undefined || used < 0) {
			continue;
		}
		const unit = numberOf(limit, 'unit');
		const unitMs = unit !== undefined ? ZAI_UNIT_MS[unit] : undefined;
		const count = numberOf(limit, 'number');
		const span = unitMs !== undefined && count !== undefined && count > 0 ? count * unitMs : null;
		windows.push({ scope, windowMs: span, leftPercent: Math.min(100, Math.max(0, 100 - Math.round(used))), resetAtMs: numberOf(limit, 'nextResetTime') ?? null });
	}
	return windows.length > 0 ? { kind: 'windows', windows } : UNREADABLE;
}

// --- request and report ---

/** One provider to ask: the key is resolved in the main process — `apiKey` if the renderer knows it, else `apiKeyEnv`. */
export interface QuotaTarget {
	readonly providerId: string;
	readonly displayName: string;
	readonly url: string;
	readonly format: string;
	readonly apiKey?: string;
	readonly apiKeyEnv?: string;
}

export type QuotaOutcome =
	| { readonly kind: 'answered'; readonly result: QuotaResult }
	/** No answer to read: the network, or an HTTP status the vendor gave without a body we understand. */
	| { readonly kind: 'failed'; readonly reason: string };

export interface QuotaRow {
	readonly providerId: string;
	readonly displayName: string;
	readonly format: string;
	readonly outcome: QuotaOutcome;
}

function durationLabel(ms: number | null): string {
	if (ms === null) { return 'длина неизвестна'; }
	if (ms % DAY_MS === 0) { return `${ms / DAY_MS} дн`; }
	if (ms % HOUR_MS === 0) { return `${ms / HOUR_MS} ч`; }
	return `${Math.round(ms / MINUTE_MS)} мин`;
}

function utcLabel(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The report section; empty when no provider declares `quota` — no section, no requests. */
export function formatQuotaSection(rows: readonly QuotaRow[], askedAtMs: number): string[] {
	if (rows.length === 0) {
		return [];
	}
	const lines = ['## Остаток подписки', '', `Ответ вендора, запрос в ${utcLabel(askedAtMs)}. Остаток считает сам вендор — по своим правилам и с учётом расхода вне IDE.`];
	for (const row of rows) {
		lines.push('', `### ${row.displayName}`);
		if (row.format === ZAI_MONITOR) {
			lines.push('', '_Этот запрос вендор не документирует — формат ответа может смениться без предупреждения._');
		}
		const outcome = row.outcome;
		if (outcome.kind === 'failed') {
			lines.push('', `Не удалось спросить: ${outcome.reason}`);
			continue;
		}
		const result = outcome.result;
		if (result.kind === 'vendorError') {
			lines.push('', `Вендор ответил ошибкой: ${result.message}`);
			continue;
		}
		if (result.kind === 'unreadable') {
			lines.push('', 'Ответ не удалось прочитать — данных нет.');
			continue;
		}
		lines.push('', '| Окно | Осталось | Сброс |', '|---|---|---|');
		for (const window of result.windows) {
			const name = `${window.scope ?? 'план'}, ${durationLabel(window.windowMs)}`;
			const left = window.leftPercent === null ? 'без ограничения' : `${window.leftPercent}%`;
			const reset = window.resetAtMs === null ? '—' : utcLabel(window.resetAtMs);
			lines.push(`| ${name} | ${left} | ${reset} |`);
		}
	}
	return lines;
}
