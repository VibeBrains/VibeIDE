/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
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

export interface IVibeWorkflowService {
	readonly _serviceBrand: undefined;

	/** Get all workflows from .vibe/workflows/ */
	getWorkflows(): Promise<VibeWorkflow[]>;

	/** Get a specific workflow by name */
	getWorkflow(name: string): Promise<VibeWorkflow | null>;
}

/**
 * VibeIDE Workflow Service (.vibe/workflows/).
 * Structured multi-step agent workflows with step-by-step approval.
 * Different from .vibe/prompts/ — workflows have named steps with dependencies.
 * Access via /workflow:name in chat.
 */
class VibeWorkflowService extends Disposable implements IVibeWorkflowService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService _logService: ILogService,
	) {
		super();
	}

	async getWorkflows(): Promise<VibeWorkflow[]> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) return [];

		const workflowsDir = joinPath(folders[0].uri, '.vibe', 'workflows');
		try {
			const dir = await this._fileService.resolve(workflowsDir);
			if (!dir.children) return [];

			const workflows: VibeWorkflow[] = [];
			for (const child of dir.children) {
				if (!child.name.endsWith('.json') && !child.name.endsWith('.yaml')) continue;
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
}

registerSingleton(IVibeWorkflowService, VibeWorkflowService, InstantiationType.Delayed);
