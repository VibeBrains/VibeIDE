/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVibeProviderDiagnosticsService } from '../common/vibeProviderDiagnosticsService.js';
import { mountVibeProviderDiagnostics } from './react/out/provider-diagnostics-tsx/index.js';

export const VIBEIDE_CHECK_PROVIDERS_CMD = 'vibeide.commands.checkProviders';

// ─── Command: open the «Проверка провайдеров» window ──────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_CHECK_PROVIDERS_CMD,
			title: localize2('vibeide.commands.checkProviders', 'Проверка провайдеров'),
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IVibeProviderDiagnosticsService).open();
	}
});

// ─── Lazy React mount ─────────────────────────────────────────────────────────

/**
 * Mounts the «Проверка провайдеров» React overlay **lazily** — only on first open.
 * Mirrors `VibeCommandsPaletteRootContribution`: sessions that never open the modal
 * pay zero React-bundle cost. Once mounted the portal stays and the React component
 * shows/hides itself by subscribing to the service.
 */
export class VibeProviderDiagnosticsRootContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeProviderDiagnosticsRoot';

	private _portalEl: HTMLDivElement | null = null;
	private _mounted = false;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IVibeProviderDiagnosticsService private readonly _diagService: IVibeProviderDiagnosticsService,
		@ILayoutService private readonly _layoutService: ILayoutService,
	) {
		super();

		const lazyMountSub = this._register(this._diagService.onDidChangeOpen((isOpen) => {
			if (this._mounted || !isOpen) { return; }
			this._mounted = true;
			lazyMountSub.dispose();
			vibeLog.warn('vibeProviderDiagnosticsRoot', '[VibeProviderDiagnosticsRoot] mounting React tree (first open)');
			this._tryMount();
		}));
	}

	private _tryMount(): void {
		const workbench = this._layoutService.mainContainer;
		if (!workbench) {
			vibeLog.warn('vibeProviderDiagnosticsRoot', '[VibeProviderDiagnosticsRoot] no .monaco-workbench root; modal not mounted');
			return;
		}

		const portal = document.createElement('div');
		portal.id = 'vibeide-provider-diagnostics-portal';
		workbench.appendChild(portal);
		this._portalEl = portal;

		this._instantiationService.invokeFunction(accessor => {
			const mount = mountVibeProviderDiagnostics(portal, accessor);
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
	VibeProviderDiagnosticsRootContribution.ID,
	VibeProviderDiagnosticsRootContribution,
	WorkbenchPhase.Eventually,
);
