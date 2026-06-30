/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVibeCommandsPaletteService } from '../common/vibeCommandsPaletteService.js';
import { mountVibeCommandsPalette } from './react/out/commands-palette-tsx/index.js';

export const VIBEIDE_SHOW_COMMANDS_PALETTE_CMD = 'vibeide.commands.showPalette';

// ─── Command: open the «VibeIDE Команды» window ───────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_SHOW_COMMANDS_PALETTE_CMD,
			title: localize2('vibeide.commands.showPalette', 'Команды'),
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IVibeCommandsPaletteService).open();
	}
});

// ─── Lazy React mount ─────────────────────────────────────────────────────────

/**
 * Mounts the «VibeIDE Команды» React overlay **lazily** — only when the window is
 * first opened. Mirrors `VibeModalRootContribution`: sessions that never open the
 * palette pay zero React-bundle cost. Once mounted the portal stays, and the React
 * component shows/hides itself by subscribing to the service.
 */
export class VibeCommandsPaletteRootContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeCommandsPaletteRoot';

	private _portalEl: HTMLDivElement | null = null;
	private _mounted = false;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IVibeCommandsPaletteService private readonly _paletteService: IVibeCommandsPaletteService,
		@ILayoutService private readonly _layoutService: ILayoutService,
	) {
		super();

		const lazyMountSub = this._register(this._paletteService.onDidChangeOpen((isOpen) => {
			if (this._mounted || !isOpen) { return; }
			this._mounted = true;
			lazyMountSub.dispose();
			vibeLog.warn('vibeCommandsPaletteRoot', '[VibeCommandsPaletteRoot] mounting React tree (first open)');
			this._tryMount();
		}));
	}

	private _tryMount(): void {
		const workbench = this._layoutService.activeContainer;
		if (!workbench) {
			vibeLog.warn('vibeCommandsPaletteRoot', '[VibeCommandsPaletteRoot] no .monaco-workbench root; palette not mounted');
			return;
		}

		const portal = workbench.ownerDocument.createElement('div');
		portal.id = 'vibeide-commands-palette-portal';
		workbench.appendChild(portal);
		this._portalEl = portal;

		this._instantiationService.invokeFunction(accessor => {
			const mount = mountVibeCommandsPalette(portal, accessor);
			if (mount?.dispose) {
				this._register(toDisposable(() => mount.dispose()));
			}
		});

		this._register(toDisposable(() => {
			if (this._portalEl?.parentElement) {
				this._portalEl.parentElement.removeChild(this._portalEl);
			}
			this._portalEl = null;
		}));
	}
}

registerWorkbenchContribution2(
	VibeCommandsPaletteRootContribution.ID,
	VibeCommandsPaletteRootContribution,
	WorkbenchPhase.Eventually,
);
