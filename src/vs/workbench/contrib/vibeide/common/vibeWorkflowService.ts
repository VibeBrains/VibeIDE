/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { joinPath } from '../../../../base/common/resources.js';

export interface WorkflowStep {
	name: string;
	description: string;
	requiresApproval?: boolean;
	toolConstraints?: string[]; // Allowed tool types for this step
	prompt?: string;
}

export interface VibeWorkflow {
	name: string;
	description: string;
	steps: WorkflowStep[];
	allowedModels?: string[];
}

export const IVibeWorkflowService = createDecorator<IVibeWorkflowService>('vibeWorkflowService');

export interface WorkflowRunResult {
	/** Workflow name that was dispatched */
	workflowName: string;
	/** Chat message injected into the active thread, or null if no thread was available */
	chatMessage: string | null;
	/** Whether the workflow was successfully dispatched to chat */
	dispatched: boolean;
}

export interface IVibeWorkflowService {
	readonly _serviceBrand: undefined;

	/** Get all workflows from .vibe/workflows/ */
	getWorkflows(): Promise<VibeWorkflow[]>;

	/** Get a specific workflow by name */
	getWorkflow(name: string): Promise<VibeWorkflow | null>;

	/**
	 * Fired when run() is called. Browser contributions listen and dispatch to chat.
	 * payload: the /workflow:name string ready to be injected into the chat input.
	 */
	readonly onWorkflowRunRequested: Event<{ workflowName: string; chatCommand: string }>;

	/**
	 * Dispatch a workflow by name via /workflow:<name> into chat.
	 * Phase 3b: real IPC executor. Currently emits onWorkflowRunRequested so a
	 * browser contribution can open the chat editor and inject the command.
	 */
	run(name: string): Promise<WorkflowRunResult>;
}

/**
 * VibeIDE Workflow Service (.vibe/workflows/).
 * Structured multi-step agent workflows with step-by-step approval.
 * Different from .vibe/prompts/ — workflows have named steps with dependencies.
 * Access via /workflow:name in chat.
 */
class VibeWorkflowService extends Disposable implements IVibeWorkflowService {
	declare readonly _serviceBrand: undefined;

	private readonly _onWorkflowRunRequested = this._register(new Emitter<{ workflowName: string; chatCommand: string }>());
	readonly onWorkflowRunRequested: Event<{ workflowName: string; chatCommand: string }> = this._onWorkflowRunRequested.event;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	async getWorkflows(): Promise<VibeWorkflow[]> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return []; }

		const workflowsDir = joinPath(folders[0].uri, '.vibe', 'workflows');
		try {
			const dir = await this._fileService.resolve(workflowsDir);
			if (!dir.children) { return []; }

			const workflows: VibeWorkflow[] = [];
			for (const child of dir.children) {
				if (!child.name.endsWith('.json') && !child.name.endsWith('.yaml')) { continue; }
				try {
					const content = await this._fileService.readFile(child.resource);
					const text = content.value.toString();
					const wf = JSON.parse(text) as VibeWorkflow;
					wf.name = wf.name || child.name.replace(/\.(json|yaml)$/, '');
					workflows.push(wf);
				} catch { /* skip invalid */ }
			}
			return workflows;
		} catch {
			return [];
		}
	}

	async getWorkflow(name: string): Promise<VibeWorkflow | null> {
		const workflows = await this.getWorkflows();
		return workflows.find(w => w.name === name) ?? null;
	}

	async run(name: string): Promise<WorkflowRunResult> {
		const workflow = await this.getWorkflow(name);
		if (!workflow) {
			vibeLog.warn('vibeWorkflow', `[VibeWorkflow] run(): workflow "${name}" not found in .vibe/workflows/`);
			return { workflowName: name, chatMessage: null, dispatched: false };
		}

		const chatCommand = `/workflow:${name}`;
		this._onWorkflowRunRequested.fire({ workflowName: name, chatCommand });
		vibeLog.info('vibeWorkflow', `[VibeWorkflow] run(): dispatched "${chatCommand}" via event`);
		return { workflowName: name, chatMessage: chatCommand, dispatched: true };
	}
}

registerSingleton(IVibeWorkflowService, VibeWorkflowService, InstantiationType.Delayed);
