/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decodeAutomationScript,
	checkNavigationUrl,
	resolveStepTimeout,
	AUTOMATION_DEFAULT_TIMEOUT_MS,
	AUTOMATION_HARD_TIMEOUT_CAP_MS,
} from '../../common/browserAutomationScript.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const minScript = (overrides: Record<string, unknown> = {}): unknown => ({
	version: 1,
	description: 'test',
	steps: [{ id: 'go', kind: 'navigate', target: 'https://example.com' }],
	...overrides,
});

suite('VibeBrowserAutomationService — script schema decoder + safety', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeAutomationScript', () => {
		test('happy path', () => {
			const r = decodeAutomationScript(minScript());
			assert.strictEqual(r.ok, true);
		});

		test('rejects non-1 version', () => {
			const r = decodeAutomationScript(minScript({ version: 2 }));
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'version-not-1'); }
		});

		test('rejects empty steps', () => {
			const r = decodeAutomationScript(minScript({ steps: [] }));
			assert.strictEqual(r.ok, false);
		});

		test('rejects unknown action kind', () => {
			const r = decodeAutomationScript(minScript({
				steps: [{ id: 'evil', kind: 'evaluate', value: 'window.x = 1' }],
			}));
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.reason.includes('kind-unknown:evaluate')); }
		});

		test('rejects evaluate / addScriptTag / exposeFunction (not in allowlist)', () => {
			for (const kind of ['evaluate', 'addScriptTag', 'addInitScript', 'exposeFunction']) {
				const r = decodeAutomationScript(minScript({
					steps: [{ id: 'a', kind, target: 'x' }],
				}));
				assert.strictEqual(r.ok, false, `kind=${kind} should be rejected`);
			}
		});

		test('rejects duplicate step ids', () => {
			const r = decodeAutomationScript(minScript({
				steps: [
					{ id: 'a', kind: 'click', target: '#btn' },
					{ id: 'a', kind: 'click', target: '#btn2' },
				],
			}));
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.reason.includes('duplicate-id')); }
		});

		test('rejects malformed step id', () => {
			const r = decodeAutomationScript(minScript({
				steps: [{ id: 'BAD ID', kind: 'click', target: '#btn' }],
			}));
			assert.strictEqual(r.ok, false);
		});

		test('rejects navigate without url', () => {
			const r = decodeAutomationScript(minScript({
				steps: [{ id: 'go', kind: 'navigate' }],
			}));
			assert.strictEqual(r.ok, false);
		});

		test('rejects fill without value', () => {
			const r = decodeAutomationScript(minScript({
				steps: [{ id: 'f', kind: 'fill', target: '#input' }],
			}));
			assert.strictEqual(r.ok, false);
		});

		test('rejects click without target', () => {
			const r = decodeAutomationScript(minScript({
				steps: [{ id: 'c', kind: 'click' }],
			}));
			assert.strictEqual(r.ok, false);
		});

		test('press-key requires value not target', () => {
			const r = decodeAutomationScript(minScript({
				steps: [{ id: 'k', kind: 'press-key', value: 'Enter' }],
			}));
			assert.strictEqual(r.ok, true);
		});

		test('wait-for-network-idle has no required fields', () => {
			const r = decodeAutomationScript(minScript({
				steps: [{ id: 'w', kind: 'wait-for-network-idle' }],
			}));
			assert.strictEqual(r.ok, true);
		});

		test('rejects too-long target', () => {
			const r = decodeAutomationScript(minScript({
				steps: [{ id: 'c', kind: 'click', target: 'a'.repeat(2000) }],
			}));
			assert.strictEqual(r.ok, false);
		});

		test('rejects too-long value', () => {
			const r = decodeAutomationScript(minScript({
				steps: [{ id: 'f', kind: 'fill', target: '#i', value: 'a'.repeat(6000) }],
			}));
			assert.strictEqual(r.ok, false);
		});

		test('rejects non-integer timeout', () => {
			const r = decodeAutomationScript(minScript({
				steps: [{ id: 'c', kind: 'click', target: '#btn', timeoutMs: 1.5 }],
			}));
			assert.strictEqual(r.ok, false);
		});

		test('rejects timeout > 600s cap', () => {
			const r = decodeAutomationScript(minScript({
				steps: [{ id: 'c', kind: 'click', target: '#btn', timeoutMs: 700_000 }],
			}));
			assert.strictEqual(r.ok, false);
		});

		test('rejects empty description', () => {
			const r = decodeAutomationScript(minScript({ description: '' }));
			assert.strictEqual(r.ok, false);
		});
	});

	suite('checkNavigationUrl', () => {
		test('https + allowlisted host → ok', () => {
			const r = checkNavigationUrl('https://example.com/page', {
				allowedHosts: ['example.com'],
			});
			assert.strictEqual(r.ok, true);
		});

		test('http on non-localhost → not-https', () => {
			const r = checkNavigationUrl('http://example.com', {
				allowedHosts: ['example.com'],
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'not-https'); }
		});

		test('http on localhost with flag on → ok', () => {
			const r = checkNavigationUrl('http://localhost:3000', {
				allowedHosts: ['localhost'],
				allowLocalhostHttp: true,
			});
			assert.strictEqual(r.ok, true);
		});

		test('http on localhost without flag → still rejected', () => {
			const r = checkNavigationUrl('http://localhost:3000', {
				allowedHosts: ['localhost'],
			});
			assert.strictEqual(r.ok, false);
		});

		test('host not in allowlist → not-allowlisted', () => {
			const r = checkNavigationUrl('https://malicious.example/x', {
				allowedHosts: ['safe.example'],
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'not-allowlisted'); }
		});

		test('wildcard host matches subdomain', () => {
			const r = checkNavigationUrl('https://api.example.com/v1', {
				allowedHosts: ['*.example.com'],
			});
			assert.strictEqual(r.ok, true);
		});

		test('wildcard does not match parent domain', () => {
			const r = checkNavigationUrl('https://example.com/', {
				allowedHosts: ['*.example.com'],
			});
			// `example.com` does not end with `.example.com` per the rule
			assert.strictEqual(r.ok, false);
		});

		test('malformed URL → malformed', () => {
			const r = checkNavigationUrl('not-a-url', { allowedHosts: ['x'] });
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'malformed'); }
		});

		test('javascript: scheme rejected', () => {
			const r = checkNavigationUrl('javascript:alert(1)', { allowedHosts: ['x'] });
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'not-https'); }
		});

		test('host case-insensitive', () => {
			const r = checkNavigationUrl('https://EXAMPLE.com/x', {
				allowedHosts: ['example.com'],
			});
			assert.strictEqual(r.ok, true);
		});
	});

	suite('resolveStepTimeout', () => {
		test('step timeout used when set', () => {
			const t = resolveStepTimeout({ id: 'a', kind: 'click', target: '#x', timeoutMs: 5000 });
			assert.strictEqual(t, 5000);
		});

		test('default fallback when no step timeout', () => {
			const t = resolveStepTimeout({ id: 'a', kind: 'click', target: '#x' });
			assert.strictEqual(t, AUTOMATION_DEFAULT_TIMEOUT_MS);
		});

		test('caller default override', () => {
			const t = resolveStepTimeout({ id: 'a', kind: 'click', target: '#x' }, 60_000);
			assert.strictEqual(t, 60_000);
		});

		test('hard cap clamps step timeout', () => {
			const t = resolveStepTimeout({ id: 'a', kind: 'click', target: '#x', timeoutMs: 999_999_999 });
			assert.strictEqual(t, AUTOMATION_HARD_TIMEOUT_CAP_MS);
		});

		test('hard cap clamps caller default', () => {
			const t = resolveStepTimeout({ id: 'a', kind: 'click', target: '#x' }, 999_999_999);
			assert.strictEqual(t, AUTOMATION_HARD_TIMEOUT_CAP_MS);
		});
	});
});
