/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IVibeConstraintsService } from './vibeConstraintsService.js';
import { IVibePersonaService } from './vibePersonaService.js';
import { IVibeProfilesService } from './vibeProfilesService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

export interface UnifiedConfigState {
	constraintsRules: number;
	activeProfile: string | null;
	verbosity: string;
	ask_before_assume: boolean;
	allowedModels: number; // count of allowed models (0 = all)
	pinnedFiles: number;
	hasGoals: boolean;
	/** Workspace session filter: how many skill ids limit GUIDELINES (0 = all skills). */
	skillsSessionFilterCount: number;
}

export const IVibeUnifiedConfigService = createDecorator<IVibeUnifiedConfigService>('vibeUnifiedConfigService');

export interface IVibeUnifiedConfigService {
	readonly _serviceBrand: undefined;

	/** Get aggregated config state from all .vibe/ files */
	getState(): UnifiedConfigState;

	/** Reload all .vibe/ configuration */
	reloadAll(): Promise<void>;

	readonly onConfigChanged: Event<UnifiedConfigState>;
}

/**
 * VibeIDE Unified .vibe/ Config Service.
 * Aggregates all .vibe/ settings into a single state object.
 * Powers: "Project AI Settings" unified config panel.
 */
class VibeUnifiedConfigService extends Disposable implements IVibeUnifiedConfigService {
	declare readonly _serviceBrand: undefined;

	private readonly _onConfigChanged = this._register(new Emitter<UnifiedConfigState>());
	readonly onConfigChanged = this._onConfigChanged.event;

	constructor(
		@IVibeConstraintsService private readonly _constraintsService: IVibeConstraintsService,
		@IVibePersonaService private readonly _personaService: IVibePersonaService,
		@IVibeProfilesService private readonly _profilesService: IVibeProfilesService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	getState(): UnifiedConfigState {
		const persona = this._personaService.getPersona();
		const activeProfile = this._profilesService.getActiveProfile();

		const sessIds = this._configurationService.getValue<string[]>('vibeide.skills.sessionActiveIds')?.filter(Boolean) ?? [];

		return {
			constraintsRules: 0, // Phase 2: read from VibeConstraintsService
			activeProfile: activeProfile?.name ?? null,
			verbosity: persona.verbosity ?? 'normal',
			ask_before_assume: persona.ask_before_assume ?? false,
			allowedModels: 0, // Phase 2: read from allowed-models.json
			pinnedFiles: 0, // Phase 2: read from pinned.json
			hasGoals: false, // Phase 2: check goals.md exists and has content
			skillsSessionFilterCount: sessIds.length,
		};
	}

	async reloadAll(): Promise<void> {
		await Promise.allSettled([
			this._constraintsService.reload(),
		]);
		vibeLog.debug('UnifiedConfig', 'All .vibe/ configs reloaded');
		this._onConfigChanged.fire(this.getState());
	}
}

registerSingleton(IVibeUnifiedConfigService, VibeUnifiedConfigService, InstantiationType.Delayed);
