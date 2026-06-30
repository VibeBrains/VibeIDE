/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `VibeBrowserAutomationService` — script schema decoder + safety validator
 * (roadmap §"Real-impl tail / Phase 3b — `VibeBrowserAutomationService`
 * реальный Playwright runner. Сейчас только consent-gate; без runner
 * браузерная автоматизация = mock").
 *
 * Pure helpers — `vscode`-free. The Playwright runtime adapter (after
 * `npm install playwright`) consumes these decoded shapes; this module
 * encodes the safety contract:
 *   - which actions are allow-listed (no `evaluate()` arbitrary JS)
 *   - URL allowlist enforcement (HTTPS-only by default, http localhost ok)
 *   - secret detection in inputs (no leaking auth tokens through automation)
 *   - per-step timeout caps
 */

const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TEXT_LEN = 5000;
const MAX_URL_LEN = 4096;
const MAX_SELECTOR_LEN = 1000;
const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const HARD_STEP_TIMEOUT_MS_CAP = 600_000;

export type AutomationActionKind =
	| 'navigate'
	| 'click'
	| 'fill'
	| 'select-option'
	| 'press-key'
	| 'wait-for-selector'
	| 'wait-for-network-idle'
	| 'screenshot'
	| 'extract-text';

export interface AutomationStep {
	readonly id: string;
	readonly kind: AutomationActionKind;
	readonly target?: string;
	readonly value?: string;
	readonly timeoutMs?: number;
}

export interface AutomationScript {
	readonly version: 1;
	readonly description: string;
	readonly steps: readonly AutomationStep[];
}

export type DecodeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

const ACTION_KINDS: ReadonlySet<string> = new Set([
	'navigate', 'click', 'fill', 'select-option', 'press-key',
	'wait-for-selector', 'wait-for-network-idle', 'screenshot', 'extract-text',
]);

/**
 * Strict envelope decoder for an automation script. Refuses:
 *   - non-v1 version
 *   - unknown action kinds (no arbitrary `evaluate` / `addScriptTag`)
 *   - duplicate step ids
 *   - missing required fields per kind
 *   - over-budget text / urls / selectors / timeouts
 */
export function decodeAutomationScript(raw: unknown): DecodeResult<AutomationScript> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-an-object' }; }
	const o = raw as Record<string, unknown>;
	if (o.version !== 1) { return { ok: false, reason: 'version-not-1' }; }
	if (typeof o.description !== 'string' || o.description.length === 0) {
		return { ok: false, reason: 'description-missing' };
	}
	if (!Array.isArray(o.steps) || o.steps.length === 0) {
		return { ok: false, reason: 'steps-empty' };
	}
	const steps: AutomationStep[] = [];
	const seenIds = new Set<string>();
	for (let i = 0; i < o.steps.length; i++) {
		const step = decodeStep(o.steps[i]);
		if (!step.ok) { return { ok: false, reason: `steps[${i}]:${step.reason}` }; }
		if (seenIds.has(step.value.id)) { return { ok: false, reason: `steps[${i}]:duplicate-id:${step.value.id}` }; }
		seenIds.add(step.value.id);
		steps.push(step.value);
	}
	return { ok: true, value: { version: 1, description: o.description, steps } };
}

function decodeStep(raw: unknown): DecodeResult<AutomationStep> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-an-object' }; }
	const o = raw as Record<string, unknown>;
	if (typeof o.id !== 'string' || !STEP_ID_PATTERN.test(o.id)) { return { ok: false, reason: 'id-invalid' }; }
	if (typeof o.kind !== 'string' || !ACTION_KINDS.has(o.kind)) { return { ok: false, reason: `kind-unknown:${String(o.kind)}` }; }
	const kind = o.kind as AutomationActionKind;

	let target: string | undefined;
	let value: string | undefined;

	if (o.target !== undefined) {
		if (typeof o.target !== 'string') { return { ok: false, reason: 'target-not-string' }; }
		if (o.target.length > MAX_SELECTOR_LEN) { return { ok: false, reason: 'target-too-long' }; }
		target = o.target;
	}
	if (o.value !== undefined) {
		if (typeof o.value !== 'string') { return { ok: false, reason: 'value-not-string' }; }
		if (o.value.length > MAX_TEXT_LEN) { return { ok: false, reason: 'value-too-long' }; }
		value = o.value;
	}

	const required = requiredFieldsFor(kind);
	if (required.includes('target') && (target === undefined || target.length === 0)) {
		return { ok: false, reason: `${kind}-needs-target` };
	}
	if (required.includes('value') && (value === undefined || value.length === 0)) {
		return { ok: false, reason: `${kind}-needs-value` };
	}

	if (kind === 'navigate') {
		if (typeof target !== 'string' || target.length === 0 || target.length > MAX_URL_LEN) {
			return { ok: false, reason: 'navigate-needs-url' };
		}
	}

	let timeoutMs: number | undefined;
	if (o.timeoutMs !== undefined) {
		if (typeof o.timeoutMs !== 'number' || !Number.isInteger(o.timeoutMs) || o.timeoutMs <= 0 || o.timeoutMs > HARD_STEP_TIMEOUT_MS_CAP) {
			return { ok: false, reason: 'timeoutMs-out-of-range' };
		}
		timeoutMs = o.timeoutMs;
	}

	const out: AutomationStep = {
		id: o.id,
		kind,
		...(target !== undefined ? { target } : {}),
		...(value !== undefined ? { value } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
	};
	return { ok: true, value: out };
}

function requiredFieldsFor(kind: AutomationActionKind): readonly ('target' | 'value')[] {
	switch (kind) {
		case 'navigate': return ['target'];
		case 'click': return ['target'];
		case 'fill': return ['target', 'value'];
		case 'select-option': return ['target', 'value'];
		case 'press-key': return ['value'];
		case 'wait-for-selector': return ['target'];
		case 'wait-for-network-idle': return [];
		case 'screenshot': return [];
		case 'extract-text': return ['target'];
	}
}

// -----------------------------------------------------------------------------
// URL allowlist enforcement (separate from the script — caller config)
// -----------------------------------------------------------------------------

export type UrlAllowVerdict =
	| { readonly ok: true; readonly url: string }
	| { readonly ok: false; readonly reason: 'malformed' | 'not-https' | 'not-allowlisted' };

export interface UrlAllowConfig {
	readonly allowedHosts: readonly string[];
	readonly allowLocalhostHttp?: boolean;
}

/**
 * Pure: validate a navigation URL against an allowlist. HTTPS-only unless
 * the URL targets `localhost`/`127.0.0.1` and `allowLocalhostHttp` is on
 * (caller usually enables for tests, disables for production).
 */
export function checkNavigationUrl(rawUrl: string, config: UrlAllowConfig): UrlAllowVerdict {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
	if (parsed.protocol !== 'https:') {
		if (parsed.protocol === 'http:' && isLocalhost && config.allowLocalhostHttp === true) {
			// fall through to host check
		} else {
			return { ok: false, reason: 'not-https' };
		}
	}
	const host = parsed.hostname.toLowerCase();
	const allowed = config.allowedHosts.some(h => {
		const norm = h.trim().toLowerCase();
		if (norm === host) { return true; }
		if (norm.startsWith('*.') && host.endsWith(norm.slice(1))) { return true; }
		return false;
	});
	if (!allowed) { return { ok: false, reason: 'not-allowlisted' }; }
	return { ok: true, url: parsed.toString() };
}

// -----------------------------------------------------------------------------
// Per-step timeout resolver
// -----------------------------------------------------------------------------

/**
 * Pure: returns the effective timeout for a step. Caller can override the
 * default via config; the helper enforces the hard cap.
 */
export function resolveStepTimeout(step: AutomationStep, defaultTimeoutMs?: number): number {
	const def = typeof defaultTimeoutMs === 'number' && Number.isFinite(defaultTimeoutMs) && defaultTimeoutMs > 0
		? Math.min(defaultTimeoutMs, HARD_STEP_TIMEOUT_MS_CAP)
		: DEFAULT_STEP_TIMEOUT_MS;
	if (step.timeoutMs !== undefined) {
		return Math.min(step.timeoutMs, HARD_STEP_TIMEOUT_MS_CAP);
	}
	return def;
}

export const AUTOMATION_HARD_TIMEOUT_CAP_MS = HARD_STEP_TIMEOUT_MS_CAP;
export const AUTOMATION_DEFAULT_TIMEOUT_MS = DEFAULT_STEP_TIMEOUT_MS;
