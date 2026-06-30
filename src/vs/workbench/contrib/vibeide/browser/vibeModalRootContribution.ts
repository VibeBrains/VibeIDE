/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable, toDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVibeModalService } from '../common/vibeModalService.js';
import { mountVibeModalRoot } from './react/out/modal-tsx/index.js';

/**
 * Mounts the workbench-level VibeModal portal **lazily** — only when the
 * first modal actually enters the queue.
 *
 * Why lazy: pre-Z.12 this mounted React at `WorkbenchPhase.Eventually`
 * unconditionally. That registered the global services accessor + emitter
 * subscriptions early, which (combined with later sidebar mount also
 * registering) accumulated duplicate listeners and froze the renderer
 * after the first heavy emitter burst.
 *
 * After the Z.12.2 idempotency fix in `_registerServices`, that
 * particular path is safe; but lazy-mounting is still better — sessions
 * that never show a modal pay zero React-bundle cost. At home, where the
 * catalog loads from network, no modal is shown so the React tree never
 * mounts at all.
 *
 * On the first `onDidChangeQueue` event with a non-empty queue, we mount
 * the React tree, then dispose the lazy-mount subscription (further
 * queue changes are handled inside the React component itself).
 */
export class VibeModalRootContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeModalRoot';

	private _portalEl: HTMLDivElement | null = null;
	private _mounted = false;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IVibeModalService private readonly _modalService: IVibeModalService,
		@ILayoutService private readonly _layoutService: ILayoutService,
	) {
		super();

		// Lazy: mount when a modal enters the queue. Extracted to `maybeMount` so we can ALSO run it
		// once at construction — a modal queued by an EARLIER-phase contribution (e.g. the What's New
		// modal shown at AfterRestored, before this Eventually-phase root subscribed) is already in
		// the queue, and the subscription alone only reacts to FUTURE events. Without the immediate
		// check that pre-queued modal would wait for an onDidChangeQueue that never comes and never render.
		const lazyMountSub = this._register(new MutableDisposable());
		const maybeMount = () => {
			if (this._mounted) { return; }
			if (this._modalService.getQueue().length === 0) { return; }
			this._mounted = true;
			lazyMountSub.clear();
			vibeLog.warn('vibeModalRoot', '[VibeModalRoot] mounting React tree (first modal triggered lazy mount)');
			this._tryMount();
		};
		lazyMountSub.value = this._modalService.onDidChangeQueue(maybeMount);
		maybeMount(); // catch a modal already queued before this subscription existed
	}

	private _tryMount(): void {
		const workbench = this._layoutService.activeContainer;
		if (!workbench) {
			vibeLog.warn('vibeModalRoot', '[VibeModalRoot] no .monaco-workbench root found; modal portal not mounted');
			return;
		}

		const portal = workbench.ownerDocument.createElement('div');
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
