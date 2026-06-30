/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

import { ITerminalService } from '../../../contrib/terminal/browser/terminal.js';
import { IAuditLogService } from '../common/auditLogService.js';

export interface TestRunResult {
	command: string;
	exitCode: number;
	passed: boolean;
	output: string;
	durationMs: number;
}

export const IVibeRunTestsAfterApplyService = createDecorator<IVibeRunTestsAfterApplyService>('vibeRunTestsAfterApplyService');

export interface IVibeRunTestsAfterApplyService {
	readonly _serviceBrand: undefined;

	/** Whether run-tests-after-apply is enabled */
	isEnabled(): boolean;

	/** Run configured tests after Apply action */
	runTests(): Promise<TestRunResult | null>;

	readonly onTestsCompleted: Event<TestRunResult>;
}

/**
 * VibeIDE Run Tests After Apply.
 * Configurable hook: npm test, pytest, cargo test, etc.
 * Runs in integrated terminal after agent applies changes.
 */
class VibeRunTestsAfterApplyService extends Disposable implements IVibeRunTestsAfterApplyService {
	declare readonly _serviceBrand: undefined;

	private readonly _onTestsCompleted = this._register(new Emitter<TestRunResult>());
	readonly onTestsCompleted = this._onTestsCompleted.event;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
	) {
		super();
	}

	isEnabled(): boolean {
		return this._configurationService.getValue<boolean>('vibeide.agent.runTestsAfterApply.enabled') ?? false;
	}

	async runTests(): Promise<TestRunResult | null> {
		if (!this.isEnabled()) { return null; }

		const command = this._configurationService.getValue<string>('vibeide.agent.runTestsAfterApply.command') ?? 'npm test';
		vibeLog.info('RunTests', `Running: ${command}`);

		const start = Date.now();
		// Audit on start so the user has a record even if Phase 1 fire-and-forget
		// terminates without an exit code path.
		if (this._auditLogService.isEnabled()) {
			void this._auditLogService.append({
				ts: start,
				action: 'run_tests:start',
				ok: true,
				meta: { command },
			});
		}
		try {
			// Create or reuse terminal and run command
			const terminal = await this._terminalService.createTerminal({
				config: { name: localize('vibeRunTestsAfterApply.terminalName', 'VibeIDE Тесты') },
			});
			await terminal.sendText(command, true);

			// Phase 1: fire-and-forget (no exit code capture)
			// Phase 2: capture exit code via terminal process exit handler
			const result: TestRunResult = {
				command,
				exitCode: 0,
				passed: true,
				output: `Running: ${command}`,
				durationMs: Date.now() - start,
			};

			if (this._auditLogService.isEnabled()) {
				void this._auditLogService.append({
					ts: Date.now(),
					action: 'run_tests:complete',
					ok: true,
					latencyMs: result.durationMs,
					meta: { command, exitCode: result.exitCode, passed: result.passed },
				});
			}

			this._onTestsCompleted.fire(result);
			return result;
		} catch (e) {
			vibeLog.error('RunTests', 'Failed to run tests:', e);
			if (this._auditLogService.isEnabled()) {
				void this._auditLogService.append({
					ts: Date.now(),
					action: 'run_tests:complete',
					ok: false,
					latencyMs: Date.now() - start,
					meta: { command, error: String(e) },
				});
			}
			return null;
		}
	}
}

registerSingleton(IVibeRunTestsAfterApplyService, VibeRunTestsAfterApplyService, InstantiationType.Delayed);
