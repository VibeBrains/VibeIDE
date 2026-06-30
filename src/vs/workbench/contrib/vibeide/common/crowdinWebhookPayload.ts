/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Crowdin webhook payload decoder + PR title formatter
 * (roadmap §"Pack VSIX → Crowdsource через Crowdin (бесплатный план для
 * OSS): публичный `vibeide.crowdin.com`; webhook → автоматический PR
 * `i18n: sync ru translations from Crowdin (<count> strings)`. Discord-канал
 * `#translations` для координации").
 *
 * Pure helpers — `vscode`-free. The CI workflow on `repository_dispatch`
 * (or `workflow_dispatch` triggered by Crowdin's webhook) calls these to:
 *   - validate the webhook payload shape (Crowdin → GitHub)
 *   - extract `(language, stringsCount)` for the PR title
 *   - compose the PR title in the documented format
 *
 * Crowdin webhook spec (general): https://support.crowdin.com/webhooks/
 */

const ISO_LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;

export interface CrowdinTranslationsUpdatedPayload {
	readonly event: 'translation.updated' | 'file.translated' | 'project.built';
	readonly project: string;
	readonly targetLanguageId: string;
	readonly stringsCount: number;
	readonly buildId?: string;
	readonly url?: string;
}

export type DecodeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

/**
 * Strict envelope decoder for the Crowdin webhook payload Crowdin POSTs to
 * GitHub. Refuses unknown event types, malformed locale, non-finite count.
 *
 * Crowdin sends slightly different field names depending on event; this
 * decoder handles `translation.updated`/`file.translated`/`project.built`.
 */
export function decodeCrowdinWebhookPayload(raw: unknown): DecodeResult<CrowdinTranslationsUpdatedPayload> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-an-object' }; }
	const o = raw as Record<string, unknown>;

	const event = o.event;
	if (event !== 'translation.updated' && event !== 'file.translated' && event !== 'project.built') {
		return { ok: false, reason: `event-unknown:${String(event)}` };
	}

	if (typeof o.project !== 'string' || o.project.length === 0) {
		return { ok: false, reason: 'project-missing' };
	}

	const targetLanguageId = pickLocale(o);
	if (targetLanguageId === null) {
		return { ok: false, reason: 'targetLanguageId-malformed' };
	}

	const stringsCount = pickStringsCount(o);
	if (stringsCount === null) {
		return { ok: false, reason: 'stringsCount-not-finite' };
	}

	const value: CrowdinTranslationsUpdatedPayload = {
		event,
		project: o.project,
		targetLanguageId,
		stringsCount,
		...(typeof o.buildId === 'string' && o.buildId.length > 0 ? { buildId: o.buildId } : {}),
		...(typeof o.url === 'string' && o.url.length > 0 ? { url: o.url } : {}),
	};
	return { ok: true, value };
}

function pickLocale(o: Record<string, unknown>): string | null {
	for (const key of ['targetLanguageId', 'languageId', 'locale']) {
		const v = o[key];
		if (typeof v === 'string' && ISO_LOCALE_PATTERN.test(v)) {
			return v.toLowerCase();
		}
	}
	return null;
}

function pickStringsCount(o: Record<string, unknown>): number | null {
	for (const key of ['stringsCount', 'wordsCount', 'translatedCount']) {
		const v = o[key];
		if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
			return v;
		}
	}
	return null;
}

// -----------------------------------------------------------------------------
// PR title + body composition
// -----------------------------------------------------------------------------

const PR_TITLE_MAX = 72;

/**
 * Format the PR title in the documented form:
 *   `i18n: sync <locale> translations from Crowdin (<count> strings)`
 *
 * Truncates summary if it exceeds 72 chars (rare — only if locale is very
 * long; currently impossible per the validator pattern).
 */
export function formatCrowdinPrTitle(payload: CrowdinTranslationsUpdatedPayload): string {
	const noun = payload.stringsCount === 1 ? 'string' : 'strings';
	const title = `i18n: sync ${payload.targetLanguageId} translations from Crowdin (${payload.stringsCount} ${noun})`;
	if (title.length <= PR_TITLE_MAX) { return title; }
	return title.slice(0, PR_TITLE_MAX - 1) + '…';
}

/**
 * Compose the PR body markdown with a link back to Crowdin (when URL given).
 * Pure formatter.
 */
export function formatCrowdinPrBody(payload: CrowdinTranslationsUpdatedPayload): string {
	const lines: string[] = [];
	lines.push(`## Crowdin sync`);
	lines.push('');
	lines.push(`- Project: \`${payload.project}\``);
	lines.push(`- Locale: \`${payload.targetLanguageId}\``);
	lines.push(`- Strings updated: **${payload.stringsCount}**`);
	if (payload.buildId !== undefined) { lines.push(`- Build id: \`${payload.buildId}\``); }
	if (payload.url !== undefined) { lines.push(`- Crowdin: ${payload.url}`); }
	lines.push('');
	lines.push('🤖 Auto-generated from Crowdin webhook. Review for translation quality before merge.');
	return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Signature verification (HMAC-SHA-256 of the body) — pure check
// -----------------------------------------------------------------------------

export type WebhookSignatureVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: 'missing-signature' | 'mismatch' | 'malformed-signature' };

/**
 * Compare the webhook signature against the expected one. Pure: caller
 * computes the expected HMAC via `crypto.createHmac` and passes both. The
 * helper does the constant-time-ish equality check (length-independent
 * branching reduced; not a cryptographic primitive though, callers needing
 * timing safety should prefer `crypto.timingSafeEqual`).
 *
 * Both inputs are expected to be hex-encoded; refuses malformed shape.
 */
export function verifyCrowdinSignature(
	receivedHex: string | undefined,
	expectedHex: string,
): WebhookSignatureVerdict {
	if (typeof receivedHex !== 'string' || receivedHex.length === 0) {
		return { ok: false, reason: 'missing-signature' };
	}
	const cleaned = receivedHex.trim().toLowerCase().replace(/^sha256=/, '');
	if (!/^[a-f0-9]{64}$/.test(cleaned)) {
		return { ok: false, reason: 'malformed-signature' };
	}
	const exp = expectedHex.trim().toLowerCase();
	if (cleaned.length !== exp.length) { return { ok: false, reason: 'mismatch' }; }
	let diff = 0;
	for (let i = 0; i < cleaned.length; i++) {
		diff |= cleaned.charCodeAt(i) ^ exp.charCodeAt(i);
	}
	return diff === 0 ? { ok: true } : { ok: false, reason: 'mismatch' };
}
