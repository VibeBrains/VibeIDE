/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { joinPath } from '../../../../base/common/resources.js';

export interface VibeProfile {
	name: string;
	constraints?: Record<string, unknown>;
	allowedModels?: string[];
	trustScore?: 'manual' | 'supervised' | 'auto';
	persona?: Record<string, unknown>;
}

export const IVibeProfilesService = createDecorator<IVibeProfilesService>('vibeProfilesService');

export interface IVibeProfilesService {
	readonly _serviceBrand: undefined;

	/** Get all available profiles from .vibe/profiles/ */
	getProfiles(): Promise<VibeProfile[]>;

	/** Get currently active profile */
	getActiveProfile(): VibeProfile | null;

	/** Switch to a profile (with agent-active check) */
	switchProfile(name: string, force?: boolean): Promise<{ success: boolean; requiresAgentStop: boolean }>;

	readonly onProfileChanged: Event<VibeProfile | null>;
}

/**
 * VibeIDE Profiles Service (.vibe/profiles/).
 * Named settings presets: work, personal, client-X, ci.
 * Switching mid-task → blocking dialog (handled by UI).
 */
class VibeProfilesService extends Disposable implements IVibeProfilesService {
	declare readonly _serviceBrand: undefined;

	private readonly _onProfileChanged = this._register(new Emitter<VibeProfile | null>());
	readonly onProfileChanged = this._onProfileChanged.event;

	private _activeProfile: VibeProfile | null = null;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	async getProfiles(): Promise<VibeProfile[]> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return []; }

		const profilesDir = joinPath(folders[0].uri, '.vibe', 'profiles');
		try {
			const dir = await this._fileService.resolve(profilesDir);
			if (!dir.children) { return []; }

			const profiles: VibeProfile[] = [];
			for (const child of dir.children) {
				if (!child.name.endsWith('.json')) { continue; }
				try {
					const content = await this._fileService.readFile(child.resource);
					const profile = JSON.parse(content.value.toString()) as VibeProfile;
					profile.name = profile.name || child.name.replace('.json', '');
					profiles.push(profile);
				} catch { /* skip invalid */ }
			}
			return profiles;
		} catch {
			return [];
		}
	}

	getActiveProfile(): VibeProfile | null {
		return this._activeProfile;
	}

	async switchProfile(name: string, force: boolean = false): Promise<{ success: boolean; requiresAgentStop: boolean }> {
		const profiles = await this.getProfiles();
		const profile = profiles.find(p => p.name === name);

		if (!profile) {
			vibeLog.warn('Profiles', `Profile not found: ${name}`);
			return { success: false, requiresAgentStop: false };
		}

		// Phase 1: switch immediately (Phase 2: check for active agent and show dialog)
		this._activeProfile = profile;
		vibeLog.info('Profiles', `Switched to profile: ${name}`);
		this._onProfileChanged.fire(profile);
		return { success: true, requiresAgentStop: false };
	}
}

registerSingleton(IVibeProfilesService, VibeProfilesService, InstantiationType.Delayed);
