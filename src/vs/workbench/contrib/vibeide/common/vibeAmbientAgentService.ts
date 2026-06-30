/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';

import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Surface the ambient-agent master flag in VS Code's Settings UI. Without this
// block the key read by the service exists only via `?? false` fallback, so
// users never see it in the editor and can't opt in to background monitoring
// without editing settings.json by hand.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.ambientAgent.enabled': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.ambientAgent.enabled', 'Включить ambient agent — фоновый мониторинг workspace (file changes, build errors, missing tests, outdated dependencies) с автоматическими подсказками. Off-by-default — фоновая аналитика и автоматические notification расцениваются как opt-in поведение.'),
		},
	},
});

export interface AmbientSuggestion {
	type: 'missing_test' | 'high_complexity' | 'security_issue' | 'outdated_dep';
	filePath?: string;
	message: string;
	actionLabel: string;
}

export const IVibeAmbientAgentService = createDecorator<IVibeAmbientAgentService>('vibeAmbientAgentService');

export interface IVibeAmbientAgentService {
	readonly _serviceBrand: undefined;

	/** Whether ambient agent is enabled (MUST be explicit opt-in) */
	isEnabled(): boolean;

	/** Get pending suggestions (shown at end of session, not real-time) */
	getSuggestions(): AmbientSuggestion[];

	readonly onSuggestionsReady: Event<AmbientSuggestion[]>;
}

/**
 * VibeIDE Ambient Agent.
 * Background monitoring: ненавязчивые предложения автоматизации.
 * 
 * CRITICAL PRIVACY RULE:
 * - EXPLICIT OPT-IN (not opt-out)
 * - In privacy/offline mode: FORCED OFF
 * - Suggestions at END of session (not real-time interruptions)
 * - No raw observation data in suggestions (aggregate patterns only)
 */
class VibeAmbientAgentService extends Disposable implements IVibeAmbientAgentService {
	declare readonly _serviceBrand: undefined;

	private readonly _onSuggestionsReady = this._register(new Emitter<AmbientSuggestion[]>());
	readonly onSuggestionsReady = this._onSuggestionsReady.event;

	private _suggestions: AmbientSuggestion[] = [];

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	isEnabled(): boolean {
		// Explicit opt-in + disabled in privacy mode
		const enabled = this._configurationService.getValue<boolean>('vibeide.ambientAgent.enabled') ?? false;
		// TODO: check privacy/stealth mode
		return enabled;
	}

	getSuggestions(): AmbientSuggestion[] {
		if (!this.isEnabled()) { return []; }
		return [...this._suggestions];
	}
}

registerSingleton(IVibeAmbientAgentService, VibeAmbientAgentService, InstantiationType.Delayed);
