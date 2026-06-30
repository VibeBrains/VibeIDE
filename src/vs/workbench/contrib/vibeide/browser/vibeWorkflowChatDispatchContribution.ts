/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVibeWorkflowService } from '../common/vibeWorkflowService.js';
import { IChatThreadService } from './chatThreadService.js';

/**
 * Bridges IVibeWorkflowService.onWorkflowRunRequested → chat thread.
 * When a Project Command (workflowId) or palette action calls workflow.run(),
 * this contribution injects the /workflow:<name> string as a user message into
 * the current chat thread so the agent executes it immediately.
 */
export class VibeWorkflowChatDispatchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeWorkflowChatDispatch';

	constructor(
		@IVibeWorkflowService private readonly _workflows: IVibeWorkflowService,
		@IChatThreadService private readonly _chatThread: IChatThreadService,
	) {
		super();
		this._register(this._workflows.onWorkflowRunRequested(e => this._dispatch(e)));
	}

	private _dispatch({ chatCommand }: { workflowName: string; chatCommand: string }): void {
		const thread = this._chatThread.getCurrentThread();
		void this._chatThread.addUserMessageAndStreamResponse({
			userMessage: chatCommand,
			threadId: thread.id,
		});
	}
}

registerWorkbenchContribution2(
	VibeWorkflowChatDispatchContribution.ID,
	VibeWorkflowChatDispatchContribution,
	WorkbenchPhase.AfterRestored,
);
