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
import { IVibeNotifySoundsModalService } from '../common/vibeNotifySoundsModalService.js';
import { mountVibeNotifySounds } from './react/out/vibe-sounds-tsx/index.js';

export const VIBEIDE_OPEN_SOUNDS_CMD = 'vibeide.sounds.open';

// ─── Command: open the «VibeIDE Звуки» window ─────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_OPEN_SOUNDS_CMD,
			title: localize2('vibeide.sounds.open', 'VibeIDE Звуки'),
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IVibeNotifySoundsModalService).open();
	}
});

// ─── Lazy React mount ─────────────────────────────────────────────────────────

/**
 * Mounts the «VibeIDE Звуки» React overlay lazily — only on first open. Mirrors
 * VibeProviderDiagnosticsRootContribution: sessions that never open the editor pay zero
 * React-bundle cost; once mounted the portal stays and the component shows/hides itself.
 */
export class VibeNotifySoundsRootContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeNotifySoundsRoot';

	private _portalEl: HTMLDivElement | null = null;
	private _mounted = false;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IVibeNotifySoundsModalService private readonly _modalService: IVibeNotifySoundsModalService,
		@ILayoutService private readonly _layoutService: ILayoutService,
	) {
		super();

		const lazyMountSub = this._register(this._modalService.onDidChangeOpen((isOpen) => {
			if (this._mounted || !isOpen) { return; }
			this._mounted = true;
			lazyMountSub.dispose();
			this._tryMount();
		}));
	}

	private _tryMount(): void {
		// `activeContainer` is the `.monaco-workbench` element of the focused window,
		// keeping the portal multi-window-safe without fragile DOM selectors.
		const workbench = this._layoutService.activeContainer;
		if (!workbench) {
			vibeLog.warn('vibeNotifySoundsRoot', '[VibeNotifySoundsRoot] no .monaco-workbench root; modal not mounted');
			return;
		}

		const portal = document.createElement('div');
		portal.id = 'vibeide-notify-sounds-portal';
		workbench.appendChild(portal);
		this._portalEl = portal;

		this._instantiationService.invokeFunction(accessor => {
			const mount = mountVibeNotifySounds(portal, accessor);
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
	VibeNotifySoundsRootContribution.ID,
	VibeNotifySoundsRootContribution,
	WorkbenchPhase.Eventually,
);
