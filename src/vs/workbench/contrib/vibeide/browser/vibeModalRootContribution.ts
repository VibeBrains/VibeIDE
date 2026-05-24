/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { mountVibeModalRoot } from './react/out/modal-tsx/index.js';

/**
 * Mounts the workbench-level VibeModal portal once the workbench is up.
 *
 * Why a separate contribution: VibeModal needs to overlay the entire
 * workbench (above sidebar / aux bar / editor groups), so the React root
 * must attach to `.monaco-workbench` or `document.body` — neither of which
 * is a Pane / Composite. This contribution finds the workbench root in
 * `WorkbenchPhase.Eventually` (after layout settles), appends a portal div,
 * and mounts the React tree.
 *
 * Lifecycle: on dispose (window close), unmount React + remove the portal
 * div. The CSS lives in `media/vibeModal.css` and is loaded via
 * `vibeide.contribution.ts` standard CSS import path.
 */
export class VibeModalRootContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeModalRoot';

	private _portalEl: HTMLDivElement | null = null;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._tryMount();
	}

	private _tryMount(): void {
		const workbench = document.querySelector<HTMLElement>('.monaco-workbench')
			?? document.body;
		if (!workbench) {
			// No DOM root yet — extremely unlikely at WorkbenchPhase.Eventually,
			// but bail safely without crashing the workbench.
			console.warn('[VibeModalRoot] no .monaco-workbench root found; modal portal not mounted');
			return;
		}

		const portal = document.createElement('div');
		portal.id = 'vibeide-modal-portal';
		portal.dataset['testid'] = 'vibeide-modal-portal';
		workbench.appendChild(portal);
		this._portalEl = portal;

		this._instantiationService.invokeFunction(accessor => {
			const mount = mountVibeModalRoot(portal, accessor);
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
	VibeModalRootContribution.ID,
	VibeModalRootContribution,
	WorkbenchPhase.Eventually,
);
