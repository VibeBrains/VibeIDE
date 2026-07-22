/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Desktop-only: lets a built-in cloud provider inherit its API key from the OS environment
// (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) instead of forcing the user to paste it into Settings.
//
// Split of responsibility — the key VALUE is never shipped to the renderer: electron-main reads it
// straight from `process.env` at send time (sendLLMMessage.impl). What travels here is only the
// PRESENCE flag, which the settings service needs so the provider counts as configured and its
// models show up in the UI. Without this half, an env-only key would authenticate fine yet leave
// the provider invisible and unusable.
//
// Read once at startup: `getShellEnv()` resolves the login-shell environment (same source the
// terminal and the extension host use), so a key exported in ~/.zshrc is picked up even when the
// app was launched from Finder/Dock rather than a shell. Changing the variable takes effect on the
// next launch, matching how every other OS-env consumer in the workbench behaves.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IShellEnvironmentService } from '../../../services/environment/electron-browser/shellEnvironmentService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { apiKeyEnvVarOfProvider, envCapableProviderNames, ProviderName } from '../common/vibeideSettingsTypes.js';

class VibeEnvApiKeysContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeEnvApiKeys';

	constructor(
		@IShellEnvironmentService private readonly shellEnvironmentService: IShellEnvironmentService,
		@IVibeideSettingsService private readonly vibeideSettingsService: IVibeideSettingsService,
	) {
		super();
		void this._apply();
	}

	private async _apply(): Promise<void> {
		try {
			// The stored state overwrites _didFillInProviderSettings when it lands, so wait for it
			// before injecting — otherwise our recompute would be discarded by the initial load.
			await this.vibeideSettingsService.waitForInitState;
			const env = await this.shellEnvironmentService.getShellEnv();

			const providersWithEnvKey = new Set<ProviderName>();
			for (const providerName of envCapableProviderNames) {
				const value = env[apiKeyEnvVarOfProvider[providerName]];
				if (typeof value === 'string' && value.trim()) {
					providersWithEnvKey.add(providerName);
				}
			}

			if (providersWithEnvKey.size === 0) { return; } // nothing to unblock — leave state untouched
			this.vibeideSettingsService.applyEnvApiKeyProviders(providersWithEnvKey);
		} catch {
			// Resolving the shell environment is best-effort: a failure here must never break the
			// workbench, it just means keys have to be entered in Settings as before.
		}
	}
}

registerWorkbenchContribution2(VibeEnvApiKeysContribution.ID, VibeEnvApiKeysContribution, WorkbenchPhase.AfterRestored);
