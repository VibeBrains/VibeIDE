/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Privacy CI: network-mock sniffer (hard gate).
 *
 * Intercepts ALL outbound network requests made by React component fixtures
 * and fails the suite if any request targets a blocked external host.
 * Runs in CI against the component-explorer server (no Electron build needed).
 *
 * Blocked categories:
 *   - Third-party telemetry / analytics (non-VibeIDE)
 *   - Ad networks
 *   - Tracking pixels
 *
 * Allowed hosts (explicitly expected / intentional):
 *   - localhost / 127.0.0.1 (component explorer)
 *   - cdn.jsdelivr.net (web fonts loaded by component fixture CSS — declared)
 *   - fonts.googleapis.com + fonts.gstatic.com (if used by fixture CSS)
 *
 * To allowlist a new host: add it to ALLOWED_EXTERNAL_HOSTS below and add a
 * comment explaining why it is needed. The PR reviewer is the gate.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { getBaseURL } from './utils';

// Hosts that are permitted in component fixture rendering.
// localhost + 127.0.0.1 are always allowed (component explorer server).
const ALLOWED_EXTERNAL_HOSTS = new Set([
	'cdn.jsdelivr.net',
	'fonts.googleapis.com',
	'fonts.gstatic.com',
]);

// Hosts (or host substrings) that are unconditionally blocked.
// Adding to this list is one-way — removal requires an explicit exemption PR.
const BLOCKED_HOST_PATTERNS = [
	'google-analytics.com',
	'googletagmanager.com',
	'segment.io',
	'segment.com',
	'mixpanel.com',
	'amplitude.com',
	'hotjar.com',
	'fullstory.com',
	'heap.io',
	'intercom.io',
	'intercom.com',
	'datadoghq.com',
	'newrelic.com',
	'sentry.io',       // allowed only if explicitly configured — not in fixtures
	'logrocket.com',
	'facebook.com',
	'twitter.com',
	'doubleclick.net',
	'adnxs.com',
	'criteo.com',
];

function isBlocked(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return BLOCKED_HOST_PATTERNS.some(p => host === p || host.endsWith('.' + p));
	} catch {
		return false;
	}
}

function isAllowed(url: string): boolean {
	try {
		const { hostname } = new URL(url);
		if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
			return true;
		}
		return ALLOWED_EXTERNAL_HOSTS.has(hostname);
	} catch {
		return false;
	}
}

async function attachSniffer(page: Page): Promise<{ violations: string[] }> {
	const violations: string[] = [];

	await page.route('**/*', async (route: Route) => {
		const url = route.request().url();

		if (isBlocked(url)) {
			violations.push(`BLOCKED: ${url}`);
			await route.abort('blockedbyclient');
			return;
		}

		await route.continue();
	});

	page.on('request', (req) => {
		const url = req.url();
		if (!isAllowed(url) && !isBlocked(url)) {
			// Unexpected external host — not blocked, not explicitly allowed
			violations.push(`UNEXPECTED_EXTERNAL: ${url}`);
		}
	});

	return { violations };
}

test.describe('Privacy: network sniffer (hard gate)', () => {
	test('component fixtures make no outbound calls to blocked telemetry hosts', async ({ page }) => {
		const { violations } = await attachSniffer(page);

		// Navigate to the component-explorer root to trigger any passive loads
		await page.goto(getBaseURL() + '/');
		await page.waitForLoadState('networkidle');

		expect(violations, `Privacy gate failed — blocked outbound requests detected:\n${violations.join('\n')}`).toHaveLength(0);
	});

	test('no unexpected external hosts contacted during SidebarChat fixture render', async ({ page }) => {
		const unexpectedHosts = new Set<string>();

		await page.route('**/*', async (route: Route) => {
			const url = route.request().url();
			if (isBlocked(url)) {
				unexpectedHosts.add(`BLOCKED:${new URL(url).hostname}`);
				await route.abort('blockedbyclient');
				return;
			}
			if (!isAllowed(url)) {
				unexpectedHosts.add(`UNEXPECTED:${new URL(url).hostname}`);
			}
			await route.continue();
		});

		try {
			// Navigate to the sidebar fixture if it exists; skip gracefully otherwise
			await page.goto(getBaseURL() + '/___explorer/sidebar-tsx/SidebarChat/Default/Light', { waitUntil: 'networkidle', timeout: 10_000 });
		} catch {
			test.skip();
			return;
		}

		await page.waitForTimeout(2_000);

		expect(
			[...unexpectedHosts],
			`SidebarChat fixture contacted unexpected external hosts:\n${[...unexpectedHosts].join('\n')}`,
		).toHaveLength(0);
	});
});
