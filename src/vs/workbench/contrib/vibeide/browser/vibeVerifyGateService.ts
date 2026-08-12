/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

import { ITerminalToolService } from './terminalToolService.js';
import { IAuditLogService } from '../common/auditLogService.js';
import { VerifyGateMode } from '../common/verifyGatePolicy.js';

export interface VerifyResult {
	readonly command: string;
	/** Exit code, or null when the command timed out / produced no code. */
	readonly exitCode: number | null;
	readonly passed: boolean;
	readonly output: string;
}

export const IVibeVerifyGateService = createDecorator<IVibeVerifyGateService>('vibeVerifyGateService');

export interface IVibeVerifyGateService {
	readonly _serviceBrand: undefined;

	/** Current gate mode (`vibeide.agent.verifyGate.mode`). */
	getMode(): VerifyGateMode;

	/** Configured bounce ceiling (`vibeide.agent.verifyGate.maxAttempts`). */
	getMaxAttempts(): number;

	/**
	 * Run the configured verify command in `cwd` and capture its exit code. Returns `null` when the
	 * gate is inert (mode `off` or no command configured) or when the command could not be launched —
	 * an inert/broken gate must never block completion. `cwd` is the workspace-root fsPath.
	 */
	runVerify(cwd: string | null): Promise<VerifyResult | null>;

	/** True while a verify command is running. */
	readonly isRunning: boolean;

	/**
	 * Fires when the gate starts or finishes running its command.
	 *
	 * The gate runs a build or a test suite — minutes, not milliseconds — at the end of a turn, and
	 * until now it did that silently: the IDE looked idle while a command was holding the turn open.
	 */
	readonly onDidChangeRunning: Event<boolean>;
}

const MAX_OUTPUT_CHARS = 8000;

class VibeVerifyGateService extends Disposable implements IVibeVerifyGateService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRunning = this._register(new Emitter<boolean>());
	readonly onDidChangeRunning: Event<boolean> = this._onDidChangeRunning.event;

	/** Depth, not a flag: a second verify while one runs must not switch the indicator off early. */
	private _running = 0;

	get isRunning(): boolean {
		return this._running > 0;
	}

	private _setRunning(delta: 1 | -1): void {
		const was = this.isRunning;
		this._running = Math.max(0, this._running + delta);
		if (this.isRunning !== was) {
			this._onDidChangeRunning.fire(this.isRunning);
		}
	}

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ITerminalToolService private readonly _terminalToolService: ITerminalToolService,
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
	) {
		super();
	}

	getMode(): VerifyGateMode {
		const raw = this._configurationService.getValue<string>('vibeide.agent.verifyGate.mode');
		return (raw === 'warn' || raw === 'enforce') ? raw : 'off';
	}

	getMaxAttempts(): number {
		const raw = this._configurationService.getValue<number>('vibeide.agent.verifyGate.maxAttempts');
		return (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) ? Math.floor(raw) : 3;
	}

	async runVerify(cwd: string | null): Promise<VerifyResult | null> {
		if (this.getMode() === 'off') { return null; }

		const command = (this._configurationService.getValue<string>('vibeide.agent.verifyGate.command') ?? '').trim();
		if (!command) { return null; }

		const rawTimeout = this._configurationService.getValue<number>('vibeide.agent.verifyGate.timeoutMs');
		const timeoutMs = (typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout >= 5000) ? Math.floor(rawTimeout) : 300_000;

		const start = Date.now();
		vibeLog.info('VerifyGate', `Running verify: ${command}`);
		this._setRunning(1);
		try {
			const { resPromise } = await this._terminalToolService.runCommand(command, {
				type: 'temporary',
				cwd,
				terminalId: generateUuid(),
				timeoutMs,
			});
			const { result, resolveReason } = await resPromise;
			const exitCode = resolveReason.type === 'done' ? resolveReason.exitCode : null;
			// Timeout (exitCode null) counts as NOT passed — verify did not complete green.
			const passed = resolveReason.type === 'done' && resolveReason.exitCode === 0;
			const output = result.length > MAX_OUTPUT_CHARS ? `…${result.slice(-MAX_OUTPUT_CHARS)}` : result;

			if (this._auditLogService.isEnabled()) {
				void this._auditLogService.append({
					ts: Date.now(),
					action: 'verify_gate:result',
					ok: passed,
					latencyMs: Date.now() - start,
					meta: { command, exitCode, passed, timedOut: resolveReason.type === 'timeout' },
				});
			}
			return { command, exitCode, passed, output };
		} catch (e) {
			// Launch failure (bad shell, missing terminal) — treat as inert so a broken config never
			// locks completion. The user sees the log; the gate simply doesn't fire.
			vibeLog.error('VerifyGate', 'verify command failed to launch — gate inert this turn:', e);
			if (this._auditLogService.isEnabled()) {
				void this._auditLogService.append({
					ts: Date.now(),
					action: 'verify_gate:result',
					ok: false,
					latencyMs: Date.now() - start,
					meta: { command, error: String(e), launchFailed: true },
				});
			}
			return null;
		} finally {
			this._setRunning(-1);
		}
	}
}

registerSingleton(IVibeVerifyGateService, VibeVerifyGateService, InstantiationType.Delayed);
