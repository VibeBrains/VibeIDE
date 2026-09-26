/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `vibeide.chat.retryOnAnotherModel` — the vendor's safety filter declined the request, so the same model will decline
 * again; the person picks another one and the last request goes to it.
 *
 * WHY a choice and not the vendor's server-side fallback (Anthropic `fallbacks`): the fallback answers from a model
 * nobody picked, keeps routing there for about an hour without saying so on later turns, and needs a beta header.
 * Here the person sees the list and decides, and the model on the wire stays the one they chose.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { localize, localize2 } from '../../../../nls.js';
import { IChatThreadService } from './chatThreadService.js';
import { IVibeideSettingsService, ModelOption } from '../common/vibeideSettingsService.js';
import { modelSelectionsEqual } from '../common/vibeideSettingsTypes.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';

registerAction2(class RetryOnAnotherModelAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.chat.retryOnAnotherModel',
			title: localize2('vibeide.chat.retryOnAnotherModel', 'Повторить запрос на другой модели'),
			f1: true,
			category: VIBE_COMMAND_CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, threadIdArg?: string): Promise<void> {
		const chatThreadService = accessor.get(IChatThreadService);
		const settingsService = accessor.get(IVibeideSettingsService);
		const quickInput = accessor.get(IQuickInputService);

		const threadId = typeof threadIdArg === 'string' ? threadIdArg : chatThreadService.state.currentThreadId;
		if (!threadId) {
			return;
		}
		const current = settingsService.state.modelSelectionOfFeature['Chat'];
		const options = settingsService.state._modelOptions.filter(option => !current || !modelSelectionsEqual(option.selection, current));
		const picked = await quickInput.pick<IQuickPickItem & { option: ModelOption }>(
			options.map(option => ({ label: option.name, option })),
			{ placeHolder: localize('vibeide.chat.retryOnAnotherModel.pick', 'На какой модели повторить запрос') },
		);
		if (picked) {
			await chatThreadService.retryOnModel(threadId, picked.option.selection);
		}
	}
});
