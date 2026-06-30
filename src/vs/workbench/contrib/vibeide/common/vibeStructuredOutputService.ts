/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';

import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Surface the structured-output mode flag in VS Code's Settings UI. Without
// this block the key read by `_updateConfiguration` exists only via `?? false`
// fallback, so users never see it in the editor and can't pipe agent events
// to a SIEM / observability stack without editing settings.json by hand.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.output.structuredMode': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.output.structuredMode', 'Эмитить каждое агентское действие как newline-delimited JSON event в stdout — формат, готовый для SIEM/Splunk/Datadog и custom observability-dashboard. Off-by-default: предназначен для headless/CI и observability-сценариев, не для интерактивного использования.'),
		},
	},
});

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
		if (!this._enabled) { return; }

		try {
			// Output newline-delimited JSON (NDJSON)
			const line = JSON.stringify(event);
			// Use process.stdout if available (Electron main process or CLI)
			if (typeof process !== 'undefined' && process.stdout) {
				process.stdout.write(line + '\n');
			} else {
				vibeLog.info('StructuredOutput', `${line}`);
			}
		} catch (e) {
			vibeLog.warn('StructuredOutput', 'Failed to emit event:', e);
		}
	}
}

registerSingleton(IVibeStructuredOutputService, VibeStructuredOutputService, InstantiationType.Eager);
