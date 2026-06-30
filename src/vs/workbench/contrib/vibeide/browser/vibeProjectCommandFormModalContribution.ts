/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVibeProjectCommandFormModalService } from '../common/vibeProjectCommandFormModalService.js';
import { mountVibeProjectCommandFormModal } from './react/out/commands-form-tsx/index.js';

/**
 * Lazily mounts the project-command Add/Edit form modal (React) on first open — mirrors
 * `VibeCommandsPaletteRootContribution`. Sessions that never add/edit a command pay zero
 * React-bundle cost. Once mounted the portal stays; the component shows/hides via the service.
 */
export class VibeProjectCommandFormModalRootContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeProjectCommandFormModalRoot';

	private _portalEl: HTMLDivElement | null = null;
	private _mounted = false;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IVibeProjectCommandFormModalService private readonly _formModalService: IVibeProjectCommandFormModalService,
		@ILayoutService private readonly _layoutService: ILayoutService,
	) {
		super();

		const lazyMountSub = this._register(this._formModalService.onDidChange(() => {
			if (this._mounted || !this._formModalService.isOpen) { return; }
			this._mounted = true;
			lazyMountSub.dispose();
			vibeLog.warn('vibeProjectCommandFormModalRoot', '[VibeProjectCommandFormModalRoot] mounting React tree (first open)');
			this._tryMount();
		}));
	}

	private _tryMount(): void {
		const workbench = this._layoutService.activeContainer;
		if (!workbench) {
			vibeLog.warn('vibeProjectCommandFormModalRoot', '[VibeProjectCommandFormModalRoot] no .monaco-workbench root; modal not mounted');
			return;
		}

		const portal = workbench.ownerDocument.createElement('div');
		portal.id = 'vibeide-project-command-form-portal';
		workbench.appendChild(portal);
		this._portalEl = portal;

		this._instantiationService.invokeFunction(accessor => {
			const mount = mountVibeProjectCommandFormModal(portal, accessor);
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
	VibeProjectCommandFormModalRootContribution.ID,
	VibeProjectCommandFormModalRootContribution,
	WorkbenchPhase.Eventually,
);
