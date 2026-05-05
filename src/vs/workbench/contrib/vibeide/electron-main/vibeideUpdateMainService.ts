/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import * as semver from '../../../../base/common/semver/semver.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { IUpdateService, StateType } from '../../../../platform/update/common/update.js';
import { IVibeideUpdateService } from '../common/vibeideUpdateService.js';
import { VibeideCheckUpdateResponse } from '../common/vibeideUpdateServiceTypes.js';

/** GitHub release tag or product version → comparable semver string, or null. */
function normalizeSemverVersion(raw: string | undefined): string | null {
	if (!raw) {
		return null;
	}
	const trimmed = raw.trim();
	const withoutV = /^v\d/i.test(trimmed) ? trimmed.slice(1) : trimmed;
	const coerced = semver.coerce(withoutV) ?? semver.coerce(trimmed);
	return coerced ? semver.valid(coerced) : null;
}

/**
 * True when the running build is not older than the latest GitHub release tag.
 * Unparseable remote tags are treated as up-to-date (avoid false-positive nag).
 */
function isCurrentBuildUpToDateVersusGitTag(localVersion: string, remoteTagName: string): boolean {
	const remote = normalizeSemverVersion(remoteTagName);
	const local = normalizeSemverVersion(localVersion);
	if (!remote) {
		return true;
	}
	if (!local) {
		return localVersion.trim() === remoteTagName.trim();
	}
	return semver.gte(local, remote);
}

export class VibeideMainUpdateService extends Disposable implements IVibeideUpdateService {
	_serviceBrand: undefined;

	constructor(
		@IProductService private readonly _productService: IProductService,
		@IEnvironmentMainService private readonly _envMainService: IEnvironmentMainService,
		@IUpdateService private readonly _updateService: IUpdateService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IRequestService private readonly _requestService: IRequestService,
	) {
		super()
	}


	async check(explicit: boolean): Promise<VibeideCheckUpdateResponse> {

		const isDevMode = !this._envMainService.isBuilt // found in abstractUpdateService.ts

		if (isDevMode) {
			return { message: null } as const
		}

		// if disabled and not explicitly checking, return early
		if (this._updateService.state.type === StateType.Disabled) {
			if (!explicit)
				return { message: null } as const
		}

		this._updateService.checkForUpdates(false) // implicity check, then handle result ourselves

		if (this._updateService.state.type === StateType.Uninitialized) {
			// The update service hasn't been initialized yet
			return { message: explicit ? 'Checking for updates soon...' : null, action: explicit ? 'reinstall' : undefined } as const
		}

		if (this._updateService.state.type === StateType.Idle) {
			// No updates currently available
			return { message: explicit ? 'No updates found!' : null, action: explicit ? 'reinstall' : undefined } as const
		}

		if (this._updateService.state.type === StateType.CheckingForUpdates) {
			// Currently checking for updates
			return { message: explicit ? 'Checking for updates...' : null } as const
		}

		if (this._updateService.state.type === StateType.AvailableForDownload) {
			// Update available but requires manual download (mainly for Linux)
			return { message: 'A new update is available!', action: 'download', } as const
		}

		if (this._updateService.state.type === StateType.Downloading) {
			// Update is currently being downloaded
			return { message: explicit ? 'Currently downloading update...' : null } as const
		}

		if (this._updateService.state.type === StateType.Downloaded) {
			// Update has been downloaded but not yet ready
			return { message: explicit ? 'An update is ready to be applied!' : null, action: 'apply' } as const
		}

		if (this._updateService.state.type === StateType.Updating) {
			// Update is being applied
			return { message: explicit ? 'Applying update...' : null } as const
		}

		if (this._updateService.state.type === StateType.Ready) {
			// Update is ready
			return { message: 'Restart VibeIDE to update!', action: 'restart' } as const
		}

		if (this._updateService.state.type === StateType.Disabled) {
			const channel = this._configurationService.getValue<'stable' | 'beta' | 'nightly'>('update.updateChannel') || 'stable';
			return await this._manualCheckGHTagIfDisabled(explicit, channel)
		}
		return null
	}






	private async _manualCheckGHTagIfDisabled(explicit: boolean, channel: 'stable' | 'beta' | 'nightly'): Promise<VibeideCheckUpdateResponse> {
		try {
			let releaseUrl: string;
			if (channel === 'beta') {
				releaseUrl = 'https://api.github.com/repos/VibeIDETeam/VibeIDE/releases?per_page=1';
			} else if (channel === 'nightly') {
				releaseUrl = 'https://api.github.com/repos/VibeIDETeam/VibeIDE/releases?per_page=1';
			} else {
				releaseUrl = 'https://api.github.com/repos/VibeIDETeam/VibeIDE/releases/latest';
			}

			const context = await this._requestService.request({ url: releaseUrl, type: 'GET', callSite: 'vibeideUpdate' }, CancellationToken.None);
			if (context.res.statusCode !== 200) {
				throw new Error(`GitHub API returned ${context.res.statusCode}`);
			}

			const jsonData = await asJson(context);
			const data = channel === 'stable'
				? jsonData
				: Array.isArray(jsonData) ? jsonData[0] : jsonData;

			if (!data || !data.tag_name) {
				throw new Error('Invalid release data');
			}

			const remoteTag = data.tag_name as string;

			const myVersion = this._productService.version;
			const isUpToDate = isCurrentBuildUpToDateVersusGitTag(myVersion, remoteTag);

			let message: string | null
			let action: 'reinstall' | undefined

			// explicit
			if (explicit) {
				if (!isUpToDate) {
					message = 'A new version of VibeIDE is available! Please reinstall (auto-updates are disabled on this OS) - it only takes a second!'
					action = 'reinstall'
				}
				else {
					message = 'VibeIDE is up-to-date!'
				}
			}
			// not explicit
			else {
				if (!isUpToDate) {
					message = 'A new version of VibeIDE is available! Please reinstall (auto-updates are disabled on this OS) - it only takes a second!'
					action = 'reinstall'
				}
				else {
					message = null
				}
			}
			return { message, action } as const
		}
		catch (e) {
			if (explicit) {
				return {
					message: `An error occurred when fetching the latest GitHub release tag: ${e}. Please try again in ~5 minutes.`,
					action: 'reinstall',
				}
			}
			else {
				return { message: null } as const
			}
		}
	}
}
