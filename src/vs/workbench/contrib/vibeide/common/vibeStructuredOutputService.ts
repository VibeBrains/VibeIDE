/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export interface StructuredAgentEvent {
	timestamp: string;
	eventType: 'action' | 'prompt' | 'apply' | 'rollback' | 'error' | 'budget_warning';
	sessionId: string;
	action?: string;
	model?: string;
	filePath?: string;
	tokens?: { input: number; output: number };
	costUsd?: number;
	ok: boolean;
	message?: string;
}

export const IVibeStructuredOutputService = createDecorator<IVibeStructuredOutputService>('vibeStructuredOutputService');

export interface IVibeStructuredOutputService {
	readonly _serviceBrand: undefined;

	/** Whether structured output mode is enabled */
	isEnabled(): boolean;

	/** Emit a structured event to stdout/pipe */
	emit(event: StructuredAgentEvent): void;
}

/**
 * VibeIDE Structured Output Mode (opt-in).
 * Each agent action emitted as JSON to stdout/pipe.
 * Integration: SIEM/Splunk, Datadog, custom dashboards.
 * Enable via: vibeide.output.structuredMode: true
 *
 * Simpler than OTel — no overhead, just newline-delimited JSON.
 */
class VibeStructuredOutputService extends Disposable implements IVibeStructuredOutputService {
	declare readonly _serviceBrand: undefined;

	private _enabled: boolean = false;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._enabled = this._configurationService.getValue<boolean>('vibeide.output.structuredMode') ?? false;

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.output.structuredMode')) {
				this._enabled = this._configurationService.getValue<boolean>('vibeide.output.structuredMode') ?? false;
			}
		}));
	}

	isEnabled(): boolean {
		return this._enabled;
	}

	emit(event: StructuredAgentEvent): void {
		if (!this._enabled) return;

		try {
			// Output newline-delimited JSON (NDJSON)
			const line = JSON.stringify(event);
			// Use process.stdout if available (Electron main process or CLI)
			if (typeof process !== 'undefined' && process.stdout) {
				process.stdout.write(line + '\n');
			} else {
				this._logService.info(`[VibeIDE StructuredOutput] ${line}`);
			}
		} catch (e) {
			this._logService.warn('[VibeIDE StructuredOutput] Failed to emit event:', e);
		}
	}
}

registerSingleton(IVibeStructuredOutputService, VibeStructuredOutputService, InstantiationType.Eager);
