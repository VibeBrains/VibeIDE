/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Turns what the provider actually reported into lines a human can read in the error card.
 *
 * WHY: the refusal diagnostics — HTTP status, the vendor's own body code, the rate we were running
 * at, the quota left on the key — were collected and written to the debug log, but never shown. The
 * user saw «Empty response» and had no way to tell a spent quota from an unstable stream; the
 * answer existed and sat in a log file they had no reason to open.
 *
 * Formatting lives here, apart from the React card: it is the part worth testing, and the card
 * should not be the only place that knows how a refusal reads.
 *
 * Pure: diagnostics in, label/value pairs out.
 */

import { ProviderRefusalDiagnostics } from './sendLLMMessageTypes.js';

export interface ProviderErrorDetailRow {
	readonly label: string;
	readonly value: string;
}

/** Headers worth showing: the rate-limit family every vendor spells differently. */
const INTERESTING_HEADER_PREFIXES = ['x-ratelimit', 'ratelimit', 'retry-after', 'x-request-id'];

/**
 * Human-readable rows, in the order a person diagnoses: what the transport said, what the vendor's
 * body said, how hard we were pushing, what is left on the key.
 *
 * Rows are omitted when unknown rather than shown empty — a row saying «Квота: —» claims we asked
 * and got nothing, which is a different fact from «the provider never told us».
 */
export function describeProviderRefusal(diagnostics: ProviderRefusalDiagnostics | undefined): ProviderErrorDetailRow[] {
	if (!diagnostics) { return []; }
	const rows: ProviderErrorDetailRow[] = [];

	if (typeof diagnostics.httpStatus === 'number') {
		rows.push({ label: 'HTTP-статус', value: String(diagnostics.httpStatus) });
	}
	if (typeof diagnostics.bodyCode === 'number') {
		// The body code is the one that matters on providers that answer 200 with a refusal inside —
		// the case that made a MiniMax refusal indistinguishable from "the model stopped on its own".
		rows.push({ label: 'Код в теле ответа', value: String(diagnostics.bodyCode) });
	}
	if (diagnostics.bodyMessage) {
		rows.push({ label: 'Сообщение провайдера', value: diagnostics.bodyMessage });
	}
	if (diagnostics.refusalKind) {
		rows.push({
			label: 'Классификация',
			value: diagnostics.refusalAmbiguous
				? `${diagnostics.refusalKind} (по документации вендора трактуется неоднозначно)`
				: diagnostics.refusalKind,
		});
	}
	if (typeof diagnostics.requestsInWindow === 'number' && typeof diagnostics.windowSeconds === 'number' && diagnostics.windowSeconds > 0) {
		const perMinute = (diagnostics.requestsInWindow / diagnostics.windowSeconds) * 60;
		// The measured rate turns "наверное, упёрлись в лимит" into a number you can compare with the
		// plan: 7.5 запроса в минуту против лимита в 200 closes that guess in one line.
		rows.push({
			label: 'Наш темп запросов',
			value: `${diagnostics.requestsInWindow} за ${diagnostics.windowSeconds} с ≈ ${perMinute.toFixed(1)} в минуту`,
		});
	}
	if (diagnostics.quota) {
		const quota = diagnostics.quota as Record<string, unknown>;
		const parts = Object.entries(quota)
			.filter(([, value]) => value !== undefined && value !== null && value !== '')
			.map(([key, value]) => `${key}: ${String(value)}`);
		if (parts.length > 0) {
			rows.push({ label: 'Остаток квоты по ключу', value: parts.join(', ') });
		}
	}
	const headers = interestingHeaders(diagnostics.headers);
	if (headers.length > 0) {
		rows.push({ label: 'Заголовки лимитов', value: headers.join('\n') });
	}

	return rows;
}

/** Rate-limit-ish headers, `name: value` per line. Whole set kept out — most of it is noise. */
function interestingHeaders(headers: Record<string, string> | undefined): string[] {
	if (!headers) { return []; }
	return Object.entries(headers)
		.filter(([name]) => INTERESTING_HEADER_PREFIXES.some(prefix => name.toLowerCase().startsWith(prefix)))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name}: ${value}`);
}
