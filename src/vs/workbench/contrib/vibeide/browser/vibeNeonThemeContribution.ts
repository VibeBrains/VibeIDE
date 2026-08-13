/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { createLinkElement } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IDisposable, Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import * as resources from '../../../../base/common/resources.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ColorThemeData } from '../../../services/themes/common/colorThemeData.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';

import { CONFIG_NEON_EDITOR_GLOW, NeonGlowTitleBarToggleVisible } from './vibeNeonGlowTitleBar.js';

const VIBEIDE_NEON_EXTENSION_ID = 'vibeide.vibeide-neon';

/**
 * Chrome stylesheets per shipped theme. `glow` is what the editor-glow toggle turns on; a theme
 * whose two entries are equal simply ignores the toggle (that is how `vibe-neon-noglow` stays
 * glow-free while still getting its chat tokens). Adding a theme means adding a row here — the
 * resolver below reads this map instead of comparing ids, so nothing else has to change.
 */
const THEME_CHROME: ReadonlyMap<string, { readonly glow: string; readonly noGlow: string; readonly glowDefault: boolean }> = new Map([
	['vibe-neon', { glow: 'media/vibe-neon.css', noGlow: 'media/vibe-neon-noglow.css', glowDefault: true }],
	['vibe-neon-noglow', { glow: 'media/vibe-neon-noglow.css', noGlow: 'media/vibe-neon-noglow.css', glowDefault: false }],
	['vibe-graphite', { glow: 'media/vibe-graphite.css', noGlow: 'media/vibe-graphite-noglow.css', glowDefault: false }],
	['vibe-midnight', { glow: 'media/vibe-midnight.css', noGlow: 'media/vibe-midnight-noglow.css', glowDefault: false }],
	['vibe-terracotta', { glow: 'media/vibe-terracotta.css', noGlow: 'media/vibe-terracotta-noglow.css', glowDefault: false }],
	['vibe-espresso', { glow: 'media/vibe-espresso.css', noGlow: 'media/vibe-espresso-noglow.css', glowDefault: false }],
	['vibe-honey', { glow: 'media/vibe-honey.css', noGlow: 'media/vibe-honey-noglow.css', glowDefault: false }],
	['vibe-tobacco', { glow: 'media/vibe-tobacco.css', noGlow: 'media/vibe-tobacco-noglow.css', glowDefault: false }],
]);

export class VibeNeonThemeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeideNeonThemeChrome';

	private _chromeDisposable: IDisposable | undefined;
	private _generation = 0;
	private readonly _neonGlowToggleVisibleKey: IContextKey<boolean>;

	constructor(
		@IWorkbenchThemeService private readonly _themeService: IWorkbenchThemeService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._neonGlowToggleVisibleKey = NeonGlowTitleBarToggleVisible.bindTo(contextKeyService);

		this._register(toDisposable(() => this.clearChrome()));

		this._register(this._themeService.onDidColorThemeChange(() => {
			void this.applyChromeWhenActive();
		}));

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_NEON_EDITOR_GLOW)) {
				void this.applyChromeWhenActive();
			}
		}));

		void this.applyChromeWhenActive();
	}

	private clearChrome(): void {
		this._chromeDisposable?.dispose();
		this._chromeDisposable = undefined;
	}

	private resolveChromeStylesheet(theme: ColorThemeData): string | undefined {
		const chrome = theme.settingsId ? THEME_CHROME.get(theme.settingsId) : undefined;
		if (!chrome) {
			return undefined;
		}
		// The glow setting is a single global boolean, but "on by default" is a per-theme answer:
		// Vibe Neon is a neon theme and wants it, the calmer ones do not. So an untouched setting
		// falls back to the theme's own default, and any explicit user/workspace value wins.
		const inspected = this._configurationService.inspect<boolean>(CONFIG_NEON_EDITOR_GLOW);
		const explicit = inspected.userValue ?? inspected.workspaceValue ?? inspected.workspaceFolderValue;
		const glowOn = explicit ?? chrome.glowDefault;
		return glowOn ? chrome.glow : chrome.noGlow;
	}

	/** The toggle is offered only where it changes something — i.e. the two stylesheets differ. */
	private hasGlowToggle(theme: ColorThemeData): boolean {
		const chrome = theme.settingsId ? THEME_CHROME.get(theme.settingsId) : undefined;
		return chrome !== undefined && chrome.glow !== chrome.noGlow;
	}

	private async applyChromeWhenActive(): Promise<void> {
		const seq = ++this._generation;

		try {
			this.clearChrome();

			const theme = this._themeService.getColorTheme();
			if (!(theme instanceof ColorThemeData) || !theme.location) {
				this._neonGlowToggleVisibleKey.set(false);
				return;
			}

			const isOurExtensionTheme =
				(theme.extensionData !== undefined && ExtensionIdentifier.equals(theme.extensionData.extensionId, VIBEIDE_NEON_EXTENSION_ID))
				|| theme.location.fsPath.replace(/\\/g, '/').toLowerCase().includes('/vibeide-neon/');
			this._neonGlowToggleVisibleKey.set(isOurExtensionTheme && this.hasGlowToggle(theme));

			const cssRel = isOurExtensionTheme ? this.resolveChromeStylesheet(theme) : undefined;
			if (!cssRel) {
				return;
			}

			if (seq !== this._generation) {
				return;
			}

			// vibe-neon.json lives at <extensionRoot>/themes/<file>.json → parent-of-themes == extension root
			const extensionRoot = resources.dirname(resources.dirname(theme.location));
			const fragments = cssRel.split('/').filter(Boolean);
			const cssUri = resources.joinPath(extensionRoot, ...fragments);

			const element = createLinkElement();
			element.rel = 'stylesheet';
			element.type = 'text/css';
			element.className = 'vibeide-neon-chrome-extension-css';
			element.setAttribute('data-vibe-extension-id', VIBEIDE_NEON_EXTENSION_ID);
			element.href = FileAccess.uriToBrowserUri(cssUri).toString(true);

			mainWindow.document.head.appendChild(element);
			this._chromeDisposable = toDisposable(() => element.remove());

		} catch (err) {
			vibeLog.warn('vibeNeonTheme', `[VibeNeonTheme] Failed to attach chrome stylesheet: ${err}`);
		}
	}
}

registerWorkbenchContribution2(VibeNeonThemeContribution.ID, VibeNeonThemeContribution, WorkbenchPhase.AfterRestored);
