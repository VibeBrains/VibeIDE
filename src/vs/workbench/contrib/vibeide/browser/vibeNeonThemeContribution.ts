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

const CSS_GLOW = 'media/vibe-neon.css';
const CSS_NO_GLOW = 'media/vibe-neon-noglow.css';

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
		const id = theme.settingsId;
		if (id !== 'vibe-neon' && id !== 'vibe-neon-noglow') {
			return undefined;
		}
		if (id === 'vibe-neon-noglow') {
			return CSS_NO_GLOW;
		}
		const glowOn = this._configurationService.getValue<boolean>(CONFIG_NEON_EDITOR_GLOW) ?? true;
		return glowOn ? CSS_GLOW : CSS_NO_GLOW;
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
			this._neonGlowToggleVisibleKey.set(isOurExtensionTheme && theme.settingsId === 'vibe-neon');

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
