/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Multi-window lock scenario — Playwright two-context test.
 *
 * Models the runtime behaviour described in windowLockPolicy.ts:
 *   - First context: no existing lock → role = 'first-owner'.
 *   - Second context (same workspace, different windowId): valid live lock → role = 'observer'.
 *   - Second context: stale lock (heartbeat expired) → role = 'takeover-candidate'.
 *   - Second context: owner PID matches → role = 'owner' (after-restart re-attach).
 *
 * The decision logic is pure (no IO, no VS Code DI), so tests inject it via
 * page.evaluate() string expressions without needing a compiled bundle from out/.
 *
 * Two-browser-context test at the bottom verifies that Playwright properly
 * isolates two independent "windows" (storage, cookies, navigation state),
 * mirroring the isolation guarantee the lock policy relies on at runtime.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { getBaseURL } from './utils';

// ---------------------------------------------------------------------------
// Pure windowLockPolicy logic — inlined as a JS snippet, kept in sync with
// src/vs/workbench/contrib/vibeide/common/windowLockPolicy.ts.
// ---------------------------------------------------------------------------

const WINDOW_LOCK_LOGIC = /* javascript */ `
const DEFAULT_TTL_MS = 60000;
function decideWindowRole(input) {
    const ttlMs = input.ttlMs !== undefined ? input.ttlMs : DEFAULT_TTL_MS;
    if (!input.lock) return { role: 'first-owner', reason: 'no-lock' };
    if (input.currentWindowId !== undefined && input.lock.windowId === input.currentWindowId) {
        return { role: 'owner', reason: 'window-id-match' };
    }
    if (input.lock.pid === input.currentPid) return { role: 'owner', reason: 'pid-match' };
    const heartbeatAgeMs = Math.max(0, input.now - input.lock.lastHeartbeatAtMs);
    if (heartbeatAgeMs > ttlMs) {
        return { role: 'takeover-candidate', reason: 'stale-heartbeat', staleByMs: heartbeatAgeMs - ttlMs };
    }
    return { role: 'observer', reason: 'foreign-lock-valid', heartbeatAgeMs };
}
function decodeWindowLock(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw;
    const pid = typeof r.pid === 'number' && isFinite(r.pid) && r.pid > 0 ? r.pid : null;
    const startedAtMs = typeof r.startedAtMs === 'number' && isFinite(r.startedAtMs) ? r.startedAtMs : null;
    const lastHeartbeatAtMs = typeof r.lastHeartbeatAtMs === 'number' && isFinite(r.lastHeartbeatAtMs) ? r.lastHeartbeatAtMs : null;
    if (pid === null || startedAtMs === null || lastHeartbeatAtMs === null) return null;
    const windowId = typeof r.windowId === 'string' && r.windowId.length > 0 ? r.windowId : undefined;
    return { pid, startedAtMs, lastHeartbeatAtMs, windowId };
}
globalThis.decideWindowRole = decideWindowRole;
globalThis.decodeWindowLock = decodeWindowLock;
`;

type WindowRole =
	| { role: 'first-owner'; reason: string }
	| { role: 'owner'; reason: string }
	| { role: 'takeover-candidate'; reason: string; staleByMs: number }
	| { role: 'observer'; reason: string; heartbeatAgeMs: number };

/** Inject lock logic into the page as an init script so it's available before navigate. */
async function withLockLogic(page: Page): Promise<void> {
	await page.addInitScript(WINDOW_LOCK_LOGIC);
}

// ---------------------------------------------------------------------------
// Decision-logic unit tests (pure, run in page.evaluate)
// ---------------------------------------------------------------------------

test.describe('Window lock policy: pure decision logic', () => {
	test('no lock file → first-owner role', async ({ page }) => {
		await withLockLogic(page);
		await page.goto('about:blank');

		const result = await page.evaluate(
			() => (window as unknown as { decideWindowRole: (i: unknown) => WindowRole }).decideWindowRole(
				{ now: Date.now(), currentPid: 1234, lock: null }
			)
		) as WindowRole;
		expect(result.role).toBe('first-owner');
		expect(result.reason).toBe('no-lock');
	});

	test('valid lock owned by another window → observer role', async ({ page }) => {
		await withLockLogic(page);
		await page.goto('about:blank');
		const now = Date.now();

		const result = await page.evaluate(
			(args) => (window as unknown as { decideWindowRole: (i: unknown) => WindowRole }).decideWindowRole(args),
			{
				now,
				currentPid: 9999,
				currentWindowId: 'window-B',
				lock: { pid: 1234, startedAtMs: now - 30_000, lastHeartbeatAtMs: now - 5_000, windowId: 'window-A' },
				ttlMs: 60_000,
			}
		) as WindowRole;

		expect(result.role).toBe('observer');
		expect(result.reason).toBe('foreign-lock-valid');
		expect((result as { role: 'observer'; reason: string; heartbeatAgeMs: number }).heartbeatAgeMs).toBeGreaterThanOrEqual(4_900);
	});

	test('stale lock (heartbeat expired) → takeover-candidate', async ({ page }) => {
		await withLockLogic(page);
		await page.goto('about:blank');
		const now = Date.now();

		const result = await page.evaluate(
			(args) => (window as unknown as { decideWindowRole: (i: unknown) => WindowRole }).decideWindowRole(args),
			{
				now,
				currentPid: 9999,
				lock: { pid: 1234, startedAtMs: now - 200_000, lastHeartbeatAtMs: now - 90_000 },
				ttlMs: 60_000,
			}
		) as WindowRole;

		expect(result.role).toBe('takeover-candidate');
		expect(result.reason).toBe('stale-heartbeat');
		expect((result as { role: 'takeover-candidate'; reason: string; staleByMs: number }).staleByMs).toBeGreaterThan(0);
	});

	test('pid-match → owner role (after-restart re-attach)', async ({ page }) => {
		await withLockLogic(page);
		await page.goto('about:blank');
		const now = Date.now();

		const result = await page.evaluate(
			(args) => (window as unknown as { decideWindowRole: (i: unknown) => WindowRole }).decideWindowRole(args),
			{
				now,
				currentPid: 1234,
				lock: { pid: 1234, startedAtMs: now - 30_000, lastHeartbeatAtMs: now - 5_000 },
			}
		) as WindowRole;

		expect(result.role).toBe('owner');
		expect(result.reason).toBe('pid-match');
	});

	test('windowId-match → owner role (PID may differ after restart)', async ({ page }) => {
		await withLockLogic(page);
		await page.goto('about:blank');
		const now = Date.now();

		const result = await page.evaluate(
			(args) => (window as unknown as { decideWindowRole: (i: unknown) => WindowRole }).decideWindowRole(args),
			{
				now,
				currentPid: 9999,
				currentWindowId: 'win-uuid-abc',
				lock: { pid: 1234, startedAtMs: now - 30_000, lastHeartbeatAtMs: now - 5_000, windowId: 'win-uuid-abc' },
			}
		) as WindowRole;

		expect(result.role).toBe('owner');
		expect(result.reason).toBe('window-id-match');
	});

	test('decodeWindowLock: rejects malformed lock JSON (all cases null)', async ({ page }) => {
		await withLockLogic(page);
		await page.goto('about:blank');

		const results = await page.evaluate(
			(cases) => (window as unknown as { decodeWindowLock: (r: unknown) => unknown }).decodeWindowLock
				? cases.map((c: unknown) => (window as unknown as { decodeWindowLock: (r: unknown) => unknown }).decodeWindowLock(c))
				: [],
			[
				null,
				{},
				{ pid: -1, startedAtMs: 0, lastHeartbeatAtMs: 0 },
				{ pid: 'bad', startedAtMs: 0, lastHeartbeatAtMs: 0 },
				{ pid: 1, startedAtMs: null, lastHeartbeatAtMs: 0 },
			] as unknown[]
		) as unknown[];

		for (const result of results) {
			expect(result).toBeNull();
		}
	});

	test('decodeWindowLock: accepts valid lock with optional windowId', async ({ page }) => {
		await withLockLogic(page);
		await page.goto('about:blank');
		const now = Date.now();

		const result = await page.evaluate(
			(args) => (window as unknown as { decodeWindowLock: (r: unknown) => unknown }).decodeWindowLock(args),
			{ pid: 42, startedAtMs: now, lastHeartbeatAtMs: now, windowId: 'abc' }
		) as { pid: number; windowId?: string } | null;

		expect(result).not.toBeNull();
		expect(result!.pid).toBe(42);
		expect(result!.windowId).toBe('abc');
	});
});

// ---------------------------------------------------------------------------
// Multi-context integration: two independent "windows"
// ---------------------------------------------------------------------------

test.describe('Multi-window: two browser contexts (window isolation)', () => {
	test('two contexts have independent localStorage (no cross-window state leak)', async ({ browser }) => {
		const ctx1: BrowserContext = await browser.newContext();
		const ctx2: BrowserContext = await browser.newContext();

		try {
			const page1 = await ctx1.newPage();
			const page2 = await ctx2.newPage();

			// Real origin (component-explorer) so localStorage is accessible — about:blank
			// has an opaque origin and denies localStorage access.
			await page1.goto(getBaseURL() + '/');
			await page2.goto(getBaseURL() + '/');

			// Context 1 writes a simulated lock to localStorage.
			await page1.evaluate(() => {
				localStorage.setItem('.vibe-window-lock', JSON.stringify({
					pid: 1111,
					startedAtMs: Date.now(),
					lastHeartbeatAtMs: Date.now(),
					windowId: 'context-1',
				}));
			});

			// Context 2 must NOT see context 1's lock.
			const ctx2Lock = await page2.evaluate(() => localStorage.getItem('.vibe-window-lock'));
			expect(ctx2Lock).toBeNull();
		} finally {
			await ctx1.close();
			await ctx2.close();
		}
	});

	test('two contexts on the same component-explorer page load independently', async ({ browser }) => {
		const ctx1: BrowserContext = await browser.newContext();
		const ctx2: BrowserContext = await browser.newContext();

		try {
			const page1 = await ctx1.newPage();
			const page2 = await ctx2.newPage();

			await Promise.all([
				page1.goto(getBaseURL() + '/', { waitUntil: 'load', timeout: 25_000 }),
				page2.goto(getBaseURL() + '/', { waitUntil: 'load', timeout: 25_000 }),
			]);

			const title1 = await page1.title();
			const title2 = await page2.title();
			expect(title1.length).toBeGreaterThan(0);
			expect(title2.length).toBeGreaterThan(0);
		} finally {
			await ctx1.close();
			await ctx2.close();
		}
	});

	test('two-window orchestration: verifyMultiWindowLockInvariants holds for disjoint locks', async ({ browser }) => {
		// roadmap §L1066: two Playwright windows, lock-file invariants checked
		// via the pure helper `verifyMultiWindowLockInvariants` from
		// common/e2eSmokeContracts.ts. Both windows hold disjoint lock sets
		// (different agent-lock IDs) — invariant must hold.
		const ctx1: BrowserContext = await browser.newContext();
		const ctx2: BrowserContext = await browser.newContext();
		try {
			const page1 = await ctx1.newPage();
			const page2 = await ctx2.newPage();

			const MULTI_WINDOW_INVARIANT_LOGIC = `
function verifyMultiWindowLockInvariants(windows) {
    const violations = [];
    const lockToWindow = new Map();
    for (const w of windows) {
        for (const lock of w.heldLocks) {
            const existing = lockToWindow.get(lock);
            if (existing && existing.windowId !== w.windowId) {
                violations.push('lock "' + lock + '" held by both ' + existing.windowId + ' (pid ' + existing.pid + ') and ' + w.windowId + ' (pid ' + w.pid + ')');
            }
            lockToWindow.set(lock, w);
        }
    }
    for (const w of windows) {
        if (w.pid <= 0) violations.push('window ' + w.windowId + ' has invalid pid ' + w.pid);
        if (w.startedAtMs <= 0) violations.push('window ' + w.windowId + ' has invalid startedAtMs ' + w.startedAtMs);
    }
    return { ok: violations.length === 0, violations };
}
globalThis.verifyMultiWindowLockInvariants = verifyMultiWindowLockInvariants;
`;
			await ctx1.addInitScript(MULTI_WINDOW_INVARIANT_LOGIC);
			await ctx2.addInitScript(MULTI_WINDOW_INVARIANT_LOGIC);

			await page1.goto('about:blank');
			await page2.goto('about:blank');

			const now = Date.now();
			const windows = [
				{ windowId: 'window-A', pid: 1111, startedAtMs: now - 30_000, heldLocks: ['agent-lock-1', 'agent-lock-2'] },
				{ windowId: 'window-B', pid: 2222, startedAtMs: now - 20_000, heldLocks: ['agent-lock-3', 'agent-lock-4'] },
			];

			const result = await page1.evaluate(
				(args) => (window as unknown as { verifyMultiWindowLockInvariants: (w: unknown) => { ok: boolean; violations: string[] } }).verifyMultiWindowLockInvariants(args),
				windows,
			) as { ok: boolean; violations: string[] };

			expect(result.ok, `disjoint locks across two windows should be valid: ${JSON.stringify(result.violations)}`).toBe(true);
			expect(result.violations).toEqual([]);
		} finally {
			await ctx1.close();
			await ctx2.close();
		}
	});

	test('two-window orchestration: same lock held by two windows → invariant violated', async ({ browser }) => {
		const ctx1: BrowserContext = await browser.newContext();
		const ctx2: BrowserContext = await browser.newContext();
		try {
			const page1 = await ctx1.newPage();
			const page2 = await ctx2.newPage();

			const MULTI_WINDOW_INVARIANT_LOGIC = `
function verifyMultiWindowLockInvariants(windows) {
    const violations = [];
    const lockToWindow = new Map();
    for (const w of windows) {
        for (const lock of w.heldLocks) {
            const existing = lockToWindow.get(lock);
            if (existing && existing.windowId !== w.windowId) {
                violations.push('lock "' + lock + '" held by both ' + existing.windowId + ' (pid ' + existing.pid + ') and ' + w.windowId + ' (pid ' + w.pid + ')');
            }
            lockToWindow.set(lock, w);
        }
    }
    for (const w of windows) {
        if (w.pid <= 0) violations.push('window ' + w.windowId + ' has invalid pid ' + w.pid);
        if (w.startedAtMs <= 0) violations.push('window ' + w.windowId + ' has invalid startedAtMs ' + w.startedAtMs);
    }
    return { ok: violations.length === 0, violations };
}
globalThis.verifyMultiWindowLockInvariants = verifyMultiWindowLockInvariants;
`;
			await ctx1.addInitScript(MULTI_WINDOW_INVARIANT_LOGIC);
			await ctx2.addInitScript(MULTI_WINDOW_INVARIANT_LOGIC);

			await page1.goto('about:blank');
			await page2.goto('about:blank');

			const now = Date.now();
			const windows = [
				{ windowId: 'window-A', pid: 1111, startedAtMs: now - 30_000, heldLocks: ['agent-lock-SHARED'] },
				{ windowId: 'window-B', pid: 2222, startedAtMs: now - 20_000, heldLocks: ['agent-lock-SHARED'] },
			];

			const result = await page1.evaluate(
				(args) => (window as unknown as { verifyMultiWindowLockInvariants: (w: unknown) => { ok: boolean; violations: string[] } }).verifyMultiWindowLockInvariants(args),
				windows,
			) as { ok: boolean; violations: string[] };

			expect(result.ok).toBe(false);
			expect(result.violations.some(v => v.includes('agent-lock-SHARED'))).toBe(true);
		} finally {
			await ctx1.close();
			await ctx2.close();
		}
	});

	test('second context detects observer role when first holds a valid lock', async ({ browser }) => {
		const ctx1: BrowserContext = await browser.newContext();
		const ctx2: BrowserContext = await browser.newContext();

		try {
			const page1 = await ctx1.newPage();
			const page2 = await ctx2.newPage();

			await ctx1.addInitScript(WINDOW_LOCK_LOGIC);
			await ctx2.addInitScript(WINDOW_LOCK_LOGIC);

			await page1.goto('about:blank');
			await page2.goto('about:blank');

			const now = Date.now();

			// Context 2 evaluates the role with ctx1's lock (fresh heartbeat).
			const role = await page2.evaluate(
				(args) => (window as unknown as { decideWindowRole: (i: unknown) => WindowRole }).decideWindowRole(args),
				{
					now: now + 100,
					currentPid: 2222,
					currentWindowId: 'window-ctx2',
					lock: {
						pid: 1111,
						startedAtMs: now,
						lastHeartbeatAtMs: now,
						windowId: 'window-ctx1',
					},
					ttlMs: 60_000,
				}
			) as WindowRole;

			expect(role.role).toBe('observer');
			expect(role.reason).toBe('foreign-lock-valid');
		} finally {
			await ctx1.close();
			await ctx2.close();
		}
	});
});
