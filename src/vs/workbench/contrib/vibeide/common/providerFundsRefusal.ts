/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tells "you are out of money" apart from "you are going too fast".
 *
 * WHY: several vendors answer BOTH with HTTP 429. Z.AI returns `429 code 1113 — Insufficient
 * balance or no resource package` when a subscription key is pointed at the pay-as-you-go
 * endpoint; the transport says "rate limit", so the retry machinery patiently made six attempts
 * over a minute (observed live 06.08.2026) for an answer that could never change. The user
 * meanwhile read «Rate limit exceeded», which sent them looking at request frequency instead of
 * at the billing plan.
 *
 * A funds refusal is terminal for this request: retrying cannot help until money is added or the
 * endpoint is corrected. Treating it as rate limiting costs a minute of waiting and points the
 * diagnosis in the wrong direction.
 *
 * Pure: status + body text in, verdict out. No I/O.
 */

/**
 * Vendor phrasings that mean "no money / no package", not "too many requests".
 *
 * Deliberately narrow. «quota» alone is NOT here: a monthly usage quota resets on its own and is
 * closer to rate limiting, and the existing translator already has a family for it. Only wording
 * that stays true until someone pays or fixes the endpoint belongs on this list.
 */
const NO_FUNDS_PATTERNS: readonly RegExp[] = [
	/insufficient\s+(?:balance|funds|credits?)/i,
	/no\s+resource\s+package/i,
	/please\s+recharge/i,
	/account\s+balance\s+is\s+(?:insufficient|too\s+low)/i,
	/arrearage|欠费/i,
];

/** Vendor-specific numeric codes carried in the body. Z.AI: 1113 = insufficient balance. */
const NO_FUNDS_BODY_CODES: readonly string[] = ['1113'];

export interface FundsRefusal {
	/** True when retrying is pointless until the account or the endpoint changes. */
	readonly isNoFunds: boolean;
	/** Vendor code, when the body carried one — shown to the user as evidence, not as jargon. */
	readonly vendorCode?: string;
}

/**
 * Reads a refusal body. `status` is checked loosely on purpose: vendors put this behind 429, 402
 * and even 400, and the wording is the reliable signal, not the number.
 */
export function detectNoFundsRefusal(status: number, bodyText: string | undefined): FundsRefusal {
	if (!bodyText || status < 400) { return { isNoFunds: false }; }
	const matchesWording = NO_FUNDS_PATTERNS.some(pattern => pattern.test(bodyText));
	const code = NO_FUNDS_BODY_CODES.find(candidate => new RegExp(`"code"\\s*:\\s*"?${candidate}"?`).test(bodyText));
	if (!matchesWording && !code) { return { isNoFunds: false }; }
	return code ? { isNoFunds: true, vendorCode: code } : { isNoFunds: true };
}

/**
 * `statusText` for the response handed back to the SDK.
 *
 * ASCII only — `statusText` is a ByteString, and a non-Latin-1 character makes the `Response`
 * constructor itself throw (learned the hard way with an em-dash in the neighbouring quota path).
 * The human-readable Russian explanation is added later, where the error becomes a chat card.
 */
export function noFundsStatusText(refusal: FundsRefusal): string {
	return refusal.vendorCode
		? `Payment Required (provider says out of funds, code ${refusal.vendorCode}; retrying cannot help)`
		: 'Payment Required (provider says out of funds; retrying cannot help)';
}
