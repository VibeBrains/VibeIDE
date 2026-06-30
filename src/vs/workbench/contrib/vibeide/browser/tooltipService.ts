/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { mountVibeTooltip } from './react/out/vibe-tooltip/index.js';
import { h } from '../../../../base/browser/dom.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';

// Tooltip contribution that mounts the component at startup
export class TooltipContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeTooltip';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILayoutService private readonly layoutService: ILayoutService,
	) {
		super();
		this.initializeTooltip();
	}

	private initializeTooltip(): void {
		// Resolve the active workbench container (multi-window aware) via the layout service.
		const workbench = this.layoutService.activeContainer;

		if (workbench) {
			// Create a container element for the tooltip using h function
			const tooltipContainer = h('div.vibe-tooltip-container').root;
			workbench.appendChild(tooltipContainer);

			// Mount the React component
			this.instantiationService.invokeFunction((accessor: ServicesAccessor) => {
				const result = mountVibeTooltip(tooltipContainer, accessor);
				if (result && typeof result.dispose === 'function') {
					this._register(toDisposable(result.dispose));
				}
			});

			// Register cleanup for the DOM element
			this._register(toDisposable(() => {
				if (tooltipContainer.parentElement) {
					tooltipContainer.parentElement.removeChild(tooltipContainer);
				}
			}));
		}
	}
}

// Register the contribution to be initialized during the AfterRestored phase
registerWorkbenchContribution2(TooltipContribution.ID, TooltipContribution, WorkbenchPhase.AfterRestored);
