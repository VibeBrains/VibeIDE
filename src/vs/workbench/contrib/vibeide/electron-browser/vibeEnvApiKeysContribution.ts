/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Desktop-only: lets a provider inherit its API key from the OS environment instead of forcing the
// user to paste it into Settings. Covers the MERGED provider set equally:
//   • built-ins — canonical variable names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …);
//   • config providers (providers.json, workspace or ~/.vibe) — the variable each entry declares
//     in its `apiKeyEnv` field.
//
// Split of responsibility — the key VALUE is never shipped to the renderer: electron-main reads it
// straight from `process.env` at send time (sendLLMMessage.impl for built-ins, the dynamic
// transport config for config providers). What travels here is only the PRESENCE flag, which the
// settings/config-providers services need so the provider counts as configured and its models show
// up in the UI. Without this half, an env-only key would authenticate fine yet leave the provider
// invisible and unusable.
//
// Read once at startup: `getShellEnv()` resolves the login-shell environment (same source the
// terminal and the extension host use), so a key exported in ~/.zshrc is picked up even when the
// app was launched from Finder/Dock rather than a shell. Changing the variable takes effect on the
// next launch, matching how every other OS-env consumer in the workbench behaves.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IShellEnvironmentService } from '../../../services/environment/electron-browser/shellEnvironmentService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { apiKeyEnvVarOfProvider, envCapableProviderNames, ProviderId } from '../common/vibeideSettingsTypes.js';
import { IVibeDynamicProvidersService } from '../browser/vibeDynamicProvidersService.js';
import { IProcessEnvironment } from '../../../../base/common/platform.js';

class VibeEnvApiKeysContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeEnvApiKeys';

	private _shellEnv: IProcessEnvironment | undefined;
	private _lastAppliedKey = '';

	constructor(
		@IShellEnvironmentService private readonly shellEnvironmentService: IShellEnvironmentService,
		@IVibeideSettingsService private readonly vibeideSettingsService: IVibeideSettingsService,
		@IVibeDynamicProvidersService private readonly dynamicProvidersService: IVibeDynamicProvidersService,
	) {
		super();
		void this._start();
	}

	private async _start(): Promise<void> {
		try {
			// The stored state overwrites _didFillInProviderSettings when it lands, so wait for it
			// before injecting — otherwise our recompute would be discarded by the initial load.
			await this.vibeideSettingsService.waitForInitState;
			this._shellEnv = await this.shellEnvironmentService.getShellEnv();
			this._recompute();
			// Config providers load async (files + cache) and can change at runtime (file edits) —
			// re-derive the presence set whenever their entry set changes (apiKeyEnv names may differ).
			this._register(this.dynamicProvidersService.onDidChange(() => this._recompute()));
		} catch {
			// Resolving the shell environment is best-effort: a failure here must never break the
			// workbench, it just means keys have to be entered in Settings as before.
		}
	}

	private _recompute(): void {
		const env = this._shellEnv;
		if (!env) { return; }

		const providersWithEnvKey = new Set<ProviderId>();
		// Built-ins: canonical variable names.
		for (const providerName of envCapableProviderNames) {
			const value = env[apiKeyEnvVarOfProvider[providerName]];
			if (typeof value === 'string' && value.trim()) {
				providersWithEnvKey.add(providerName);
			}
		}
		// Config providers: each entry's declared `apiKeyEnv`. Overrides patch a built-in and carry
		// no selectable models of their own — presence for them rides on the built-in id above.
		for (const p of this.dynamicProvidersService.getState().providers) {
			if (p.kind === 'override' || p.entry.active === false || !p.entry.apiKeyEnv) { continue; }
			const value = env[p.entry.apiKeyEnv];
			if (typeof value === 'string' && value.trim()) {
				providersWithEnvKey.add(p.id);
			}
		}

		// Idempotence guard — applying fires state events which loop back here via onDidChange.
		const key = Array.from(providersWithEnvKey).sort().join('|');
		if (key === this._lastAppliedKey) { return; }
		this._lastAppliedKey = key;

		this.vibeideSettingsService.applyEnvApiKeyProviders(providersWithEnvKey);
		// The seeds' key gating (keyStatus/keySource/didFill) is computed inside the config-providers
		// service — poke it to rebuild against the new presence facts. Terminates: the rebuilt state
		// re-enters _recompute with an unchanged set and stops at the guard above.
		void this.dynamicProvidersService.reload();
	}
}

registerWorkbenchContribution2(VibeEnvApiKeysContribution.ID, VibeEnvApiKeysContribution, WorkbenchPhase.AfterRestored);
