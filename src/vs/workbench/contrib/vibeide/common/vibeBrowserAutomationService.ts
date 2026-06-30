/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeBrowserAutomationService — first-class Playwright/browser automation UX.
 *
 * When the agent proposes a browser run:
 *  1. User sees a consent dialog (never silently starts a browser).
 *  2. Run is isolated (separate process / Playwright project in a temp dir).
 *  3. Results (screenshot, console output, exit code) are recorded in audit log.
 *  4. Privacy: no telemetry forwarded; stealth mode blocks browser automation.
 *
 * Phase MVP: service contract + consent gate + audit events.
 * Phase 3b: actual Playwright runner via node child_process; sandboxed preview integration.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { IAuditLogService } from './auditLogService.js';
import { IVibeStealthModeService } from './vibeStealthModeService.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.browserAutomation.enabled': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.browserAutomation.enabled', 'Разрешить агенту предлагать запуски browser-автоматизации через Playwright. Подтверждение пользователя требуется на каждый запуск.'),
		},
		'vibeide.browserAutomation.maxRunMs': {
			type: 'number',
			default: 30000,
			minimum: 5000,
			maximum: 300000,
			description: localize('vibeide.browserAutomation.maxRunMs', 'Максимальное время (мс) одного запуска browser-автоматизации до принудительного завершения.'),
		},
	},
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type BrowserRunStatus = 'pending_consent' | 'approved' | 'rejected' | 'running' | 'completed' | 'failed' | 'timed_out';

export interface BrowserRunRequest {
	/** What the agent wants to do */
	goal: string;
	/** Playwright script snippet (shown to user in consent dialog) */
	scriptPreview: string;
	/** Start URL */
	startUrl?: string;
	/** Thread/task requesting the run */
	parentThreadId: string;
}

export interface BrowserRunResult {
	runId: string;
	status: 'completed' | 'failed' | 'timed_out' | 'rejected';
	/** Plain-text console output from the browser (truncated to 8KB) */
	consoleOutput?: string;
	/** Path to screenshot if captured */
	screenshotPath?: string;
	/** Exit message or error */
	message?: string;
	elapsedMs?: number;
}

export const IVibeBrowserAutomationService = createDecorator<IVibeBrowserAutomationService>('vibeBrowserAutomationService');

export interface IVibeBrowserAutomationService {
	readonly _serviceBrand: undefined;

	/** Whether browser automation feature is enabled (user opt-in) */
	isEnabled(): boolean;

	/**
	 * Propose a browser automation run.
	 * Returns a run id immediately; wait for `onRunStatusChanged` or call `awaitResult`.
	 * Throws if stealth mode is active or feature is disabled.
	 */
	proposeRun(request: BrowserRunRequest): Promise<string>;

	/** Approve a pending consent request (typically called by the consent UI) */
	approveRun(runId: string): void;

	/** Reject a pending consent request */
	rejectRun(runId: string): void;

	/** Wait for a run to reach a terminal status */
	awaitResult(runId: string): Promise<BrowserRunResult>;

	/** All runs visible to the IDE (most recent first) */
	getRuns(): Array<{ runId: string; request: BrowserRunRequest; status: BrowserRunStatus; result?: BrowserRunResult }>;

	readonly onRunStatusChanged: Event<{ runId: string; status: BrowserRunStatus }>;
}

// ── Implementation ─────────────────────────────────────────────────────────────

interface RunEntry {
	runId: string;
	request: BrowserRunRequest;
	status: BrowserRunStatus;
	result?: BrowserRunResult;
	resolve?: (r: BrowserRunResult) => void;
	reject?: (e: Error) => void;
}

class VibeBrowserAutomationService extends Disposable implements IVibeBrowserAutomationService {
	declare readonly _serviceBrand: undefined;

	private readonly _runs = new Map<string, RunEntry>();
	private readonly _onRunStatusChanged = this._register(new Emitter<{ runId: string; status: BrowserRunStatus }>());
	readonly onRunStatusChanged: Event<{ runId: string; status: BrowserRunStatus }> = this._onRunStatusChanged.event;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IAuditLogService private readonly _audit: IAuditLogService,
		@IVibeStealthModeService private readonly _stealth: IVibeStealthModeService,
	) {
		super();
	}

	isEnabled(): boolean {
		return !!this._config.getValue<boolean>('vibeide.browserAutomation.enabled');
	}

	async proposeRun(request: BrowserRunRequest): Promise<string> {
		if (!this.isEnabled()) {
			throw new Error('[VibeBrowserAutomation] Feature disabled. Enable vibeide.browserAutomation.enabled.');
		}
		if (this._stealth.isEnabled()) {
			throw new Error('[VibeBrowserAutomation] Browser automation is blocked in stealth mode.');
		}

		const runId = `browser-run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const entry: RunEntry = { runId, request, status: 'pending_consent' };
		this._runs.set(runId, entry);
		this._onRunStatusChanged.fire({ runId, status: 'pending_consent' });
		this._log.info(`[VibeBrowserAutomation] Run ${runId} proposed for thread ${request.parentThreadId}: ${request.goal.slice(0, 80)}`);
		this._audit.append({ ts: Date.now(), action: 'browser_run_proposed', ok: true, meta: { runId, goal: request.goal.slice(0, 200) } });

		return runId;
	}

	approveRun(runId: string): void {
		const entry = this._runs.get(runId);
		if (!entry || entry.status !== 'pending_consent') { return; }
		entry.status = 'approved';
		this._onRunStatusChanged.fire({ runId, status: 'approved' });
		this._executeRun(entry);
	}

	rejectRun(runId: string): void {
		const entry = this._runs.get(runId);
		if (!entry) { return; }
		entry.status = 'rejected';
		const result: BrowserRunResult = { runId, status: 'rejected', message: 'User rejected browser automation run.' };
		entry.result = result;
		this._onRunStatusChanged.fire({ runId, status: 'rejected' });
		entry.resolve?.(result);
		this._audit.append({ ts: Date.now(), action: 'browser_run_proposed', ok: false, meta: { runId, reason: 'user_rejected' } });
	}

	awaitResult(runId: string): Promise<BrowserRunResult> {
		const entry = this._runs.get(runId);
		if (!entry) { return Promise.reject(new Error(`Unknown run id: ${runId}`)); }
		if (entry.result) { return Promise.resolve(entry.result); }
		return new Promise<BrowserRunResult>((resolve, reject) => {
			entry.resolve = resolve;
			entry.reject = reject;
		});
	}

	getRuns(): Array<{ runId: string; request: BrowserRunRequest; status: BrowserRunStatus; result?: BrowserRunResult }> {
		return Array.from(this._runs.values()).reverse().map(e => ({ runId: e.runId, request: e.request, status: e.status, result: e.result }));
	}

	private async _executeRun(entry: RunEntry): Promise<void> {
		entry.status = 'running';
		this._onRunStatusChanged.fire({ runId: entry.runId, status: 'running' });
		const start = Date.now();

		try {
			const maxMs = this._config.getValue<number>('vibeide.browserAutomation.maxRunMs') ?? 30000;
			const result = await this._spawnPlaywrightRunner(entry.request, maxMs);
			result.runId = entry.runId;
			entry.result = result;
			entry.status = result.status as BrowserRunStatus;
			this._onRunStatusChanged.fire({ runId: entry.runId, status: entry.status });
			entry.resolve?.(result);
			this._audit.append({ ts: Date.now(), action: 'browser_run_proposed', ok: result.status === 'completed', meta: { runId: entry.runId, status: result.status, elapsedMs: result.elapsedMs } });
		} catch (err) {
			const result: BrowserRunResult = { runId: entry.runId, status: 'failed', message: String(err), elapsedMs: Date.now() - start };
			entry.result = result;
			entry.status = 'failed';
			this._onRunStatusChanged.fire({ runId: entry.runId, status: 'failed' });
			entry.resolve?.(result);
		}
	}

	private async _spawnPlaywrightRunner(request: BrowserRunRequest, maxMs: number): Promise<BrowserRunResult> {
		// Dynamic import so common/ stays vscode-free at import time; Electron desktop has Node.js.
		const { spawn } = await import('child_process');
		const path = await import('path');
		const { fileURLToPath } = await import('url');

		const runnerScript = path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			'../../../../../../scripts/vibe-playwright-runner.mjs'
		);

		return new Promise<BrowserRunResult>((resolve) => {
			const payload = JSON.stringify({ script: null, startUrl: request.startUrl, maxMs });
			const child = spawn(process.execPath, ['--experimental-vm-modules', runnerScript], {
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
			child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
			child.stdin.write(payload);
			child.stdin.end();

			child.on('close', () => {
				try {
					const lastLine = stdout.trim().split('\n').pop() ?? '';
					const parsed = JSON.parse(lastLine) as BrowserRunResult;
					resolve(parsed);
				} catch {
					resolve({ runId: '', status: 'failed', message: `runner parse error. stderr: ${stderr.slice(0, 500)}` });
				}
			});

			child.on('error', (err: Error) => {
				resolve({ runId: '', status: 'failed', message: `spawn error: ${err.message}` });
			});
		});
	}
}

registerSingleton(IVibeBrowserAutomationService, VibeBrowserAutomationService, InstantiationType.Delayed);
