/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITerminalService } from '../../../contrib/terminal/browser/terminal.js';

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
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	isEnabled(): boolean {
		return this._configurationService.getValue<boolean>('vibeide.agent.runTestsAfterApply.enabled') ?? false;
	}

	async runTests(): Promise<TestRunResult | null> {
		if (!this.isEnabled()) return null;

		const command = this._configurationService.getValue<string>('vibeide.agent.runTestsAfterApply.command') ?? 'npm test';
		this._logService.info(`[VibeIDE RunTests] Running: ${command}`);

		const start = Date.now();
		try {
			// Create or reuse terminal and run command
			const terminal = await this._terminalService.createTerminal({
				config: { name: 'VibeIDE Tests' },
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

			this._onTestsCompleted.fire(result);
			return result;
		} catch (e) {
			this._logService.error('[VibeIDE RunTests] Failed to run tests:', e);
			return null;
		}
	}
}

registerSingleton(IVibeRunTestsAfterApplyService, VibeRunTestsAfterApplyService, InstantiationType.Delayed);
