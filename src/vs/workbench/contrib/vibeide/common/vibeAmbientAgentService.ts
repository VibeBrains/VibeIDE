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
		@ILogService _logService: ILogService,
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
		if (!this.isEnabled()) return [];
		return [...this._suggestions];
	}
}

registerSingleton(IVibeAmbientAgentService, VibeAmbientAgentService, InstantiationType.Delayed);
