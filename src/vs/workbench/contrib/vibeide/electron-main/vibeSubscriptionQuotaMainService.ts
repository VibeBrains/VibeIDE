/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseSubscriptionQuota, QuotaOutcome, QuotaRow, QuotaTarget } from '../common/subscriptionQuota.js';

/** A vendor that does not answer in this time gets «could not ask» — the report must not hang on it. */
const QUOTA_TIMEOUT_MS = 10_000;
/** How much of an error body is shown; vendor error pages can be long. */
const ERROR_BODY_CHARS = 200;

/**
 * The request half of the subscription remains: resolves the key (renderer-known `apiKey`, else `apiKeyEnv` from the
 * process environment), asks each distinct endpoint once and reads the answer with the shared rules.
 *
 * Redirects are not followed — the request carries the API key, and a redirect could take it to another host.
 */
export class VibeSubscriptionQuotaMainService {

	async fetchAll(targets: readonly QuotaTarget[]): Promise<QuotaRow[]> {
		const seen = new Set<string>();
		const jobs: Promise<QuotaRow>[] = [];
		for (const target of targets) {
			const key = target.apiKey?.trim() || (target.apiKeyEnv ? process.env[target.apiKeyEnv]?.trim() : undefined);
			if (!key || !target.url.startsWith('https://')) {
				continue;
			}
			// One subscription behind two routes (an `extends` clone) is asked once.
			const identity = `${target.url}\n${key}`;
			if (seen.has(identity)) {
				continue;
			}
			seen.add(identity);
			jobs.push(this._fetchOne(target, key).then(outcome => ({ providerId: target.providerId, displayName: target.displayName, format: target.format, outcome })));
		}
		return Promise.all(jobs);
	}

	private async _fetchOne(target: QuotaTarget, key: string): Promise<QuotaOutcome> {
		try {
			const response = await fetch(target.url, {
				headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
				redirect: 'manual',
				signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
			});
			const body = await response.text();
			const parsed = parseSubscriptionQuota(target.format, body);
			if (response.ok) {
				return { kind: 'answered', result: parsed };
			}
			// A vendor that puts its own error in a non-2xx body is still an answer to show.
			if (parsed.kind === 'vendorError') {
				return { kind: 'answered', result: parsed };
			}
			return { kind: 'failed', reason: `HTTP ${response.status} ${body.slice(0, ERROR_BODY_CHARS)}`.trim() };
		} catch (error) {
			return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
		}
	}
}
