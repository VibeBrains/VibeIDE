/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { vibeLog } from '../common/vibeLog.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';


// to change this, just Cmd+Shift+F and replace DummyService with YourServiceName, and create a unique ID below
export interface IDummyService {
	readonly _serviceBrand: undefined; // services need this, just leave it undefined
}

export const IDummyService = createDecorator<IDummyService>('DummyService');



// An example of an action (delete if you're not using an action):
registerAction2(class extends Action2 {
	constructor() {
		super({
			f1: true,
			id: 'vibe.dummy',
			title: localize2('dummy', 'dummy: Init'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.Digit0,
				weight: KeybindingWeight.ExternalExtension,
			}
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const n = accessor.get(IDummyService);
		vibeLog.info('_dummyContrib', 'Hi', n._serviceBrand);
	}
});


class DummyService extends Disposable implements IWorkbenchContribution, IDummyService {
	static readonly ID = 'workbench.contrib.vibe.dummy'; // workbenchContributions need this, services do not
	_serviceBrand: undefined;

	constructor(
		@ICodeEditorService codeEditorService: ICodeEditorService,
	) {
		super();

	}
}


// pick one and delete the other:
registerSingleton(IDummyService, DummyService, InstantiationType.Eager); // lazily loaded, even if Eager

registerWorkbenchContribution2(DummyService.ID, DummyService, WorkbenchPhase.BlockRestore); // mounts on start
