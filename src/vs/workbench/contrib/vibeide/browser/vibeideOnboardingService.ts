/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { mountVibeOnboarding } from './react/out/vibe-onboarding/index.js';
import { h } from '../../../../base/browser/dom.js';

// Onboarding contribution that mounts the component at startup
export class OnboardingContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeOnboarding';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILayoutService private readonly layoutService: ILayoutService,
	) {
		super();
		this.initialize();
	}

	private initialize(): void {
		// The main workbench container carries the `.monaco-workbench` class.
		const workbench = this.layoutService.mainContainer;

		if (workbench) {

			const onboardingContainer = h('div.vibe-onboarding-container').root;
			workbench.appendChild(onboardingContainer);
			this.instantiationService.invokeFunction((accessor: ServicesAccessor) => {
				const result = mountVibeOnboarding(onboardingContainer, accessor);
				if (result && typeof result.dispose === 'function') {
					this._register(toDisposable(result.dispose));
				}
			});
			// Register cleanup for the DOM element
			this._register(toDisposable(() => {
				if (onboardingContainer.parentElement) {
					onboardingContainer.parentElement.removeChild(onboardingContainer);
				}
			}));
		}
	}
}

// Register the contribution to be initialized during the AfterRestored phase
registerWorkbenchContribution2(OnboardingContribution.ID, OnboardingContribution, WorkbenchPhase.AfterRestored);
