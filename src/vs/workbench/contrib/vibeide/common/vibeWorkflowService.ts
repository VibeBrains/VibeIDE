/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { isObject } from '../../../../base/common/types.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { joinPath } from '../../../../base/common/resources.js';
import { isSlashCommandFileName } from './chatSlashCommands.js';

export interface WorkflowStep {
	readonly name: string;
	readonly description: string;
	/** Instructions for this step, handed to the agent as written. */
	readonly prompt?: string;
	/** The agent stops and asks the person before starting this step. */
	readonly requiresApproval?: boolean;
}

export interface VibeWorkflow {
	/** The file name without `.json`: what follows `/workflow:`. */
	readonly id: string;
	/** A title for people; the id when the file has none. */
	readonly name: string;
	readonly description: string;
	readonly steps: readonly WorkflowStep[];
}

export type WorkflowFileParseResult =
	| { readonly workflow: VibeWorkflow }
	| { readonly error: string };

/**
 * Reads one `.vibe/workflows/<id>.json`. Pure: text in, the workflow or the reason it is not one out.
 * The reason gets logged instead of swallowed — before, a typo made the command vanish without a word.
 *
 * `toolConstraints` and `allowedModels` are not part of the format: nothing ever read them, and hard
 * per-step limits (role, tools, model, paths) are what `.vibe/pipelines.json` is for.
 */
export function parseWorkflowFile(text: string, id: string): WorkflowFileParseResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { error: `not valid JSON (${e instanceof Error ? e.message : String(e)})` };
	}
	if (!isObject(raw)) {
		return { error: 'the file must hold a JSON object' };
	}
	const file = raw as Record<string, unknown>;
	for (const key of ['name', 'description'] as const) {
		if (file[key] !== undefined && typeof file[key] !== 'string') {
			return { error: `"${key}" must be a string` };
		}
	}
	const rawSteps: unknown = file.steps;
	if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
		return { error: '"steps" must be a non-empty array' };
	}
	const steps: WorkflowStep[] = [];
	for (let i = 0; i < rawSteps.length; i++) {
		const entry: unknown = rawSteps[i];
		if (!isObject(entry)) {
			return { error: `step ${i + 1} must be an object` };
		}
		const step = entry as Record<string, unknown>;
		if (typeof step.name !== 'string' || !step.name.trim()) {
			return { error: `step ${i + 1} has no "name"` };
		}
		for (const key of ['description', 'prompt'] as const) {
			if (step[key] !== undefined && typeof step[key] !== 'string') {
				return { error: `step ${i + 1}: "${key}" must be a string` };
			}
		}
		if (step.requiresApproval !== undefined && typeof step.requiresApproval !== 'boolean') {
			return { error: `step ${i + 1}: "requiresApproval" must be true or false` };
		}
		const prompt = typeof step.prompt === 'string' ? step.prompt.trim() : '';
		steps.push({
			name: step.name.trim(),
			description: typeof step.description === 'string' ? step.description.trim() : '',
			...(prompt ? { prompt } : {}),
			...(step.requiresApproval === true ? { requiresApproval: true } : {}),
		});
	}
	const name = typeof file.name === 'string' ? file.name.trim() : '';
	return {
		workflow: {
			id,
			name: name || id,
			description: typeof file.description === 'string' ? file.description.trim() : '',
			steps,
		},
	};
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

	/** Workflows from `.vibe/workflows/*.json`; a file that fails to parse is logged and left out. */
	getWorkflows(): Promise<VibeWorkflow[]>;

	/** A workflow by its id — the file name without `.json`. */
	getWorkflow(id: string): Promise<VibeWorkflow | null>;

	/**
	 * Fired when run() is called. Browser contributions listen and dispatch to chat.
	 * payload: the /workflow:<id> string ready to be injected into the chat input.
	 */
	readonly onWorkflowRunRequested: Event<{ workflowName: string; chatCommand: string }>;

	/**
	 * Dispatch a workflow by id: emits onWorkflowRunRequested, and a browser contribution sends
	 * `/workflow:<id>` to the current chat, where the request builder expands it.
	 */
	run(id: string): Promise<WorkflowRunResult>;
}

/**
 * VibeIDE Workflow Service (.vibe/workflows/<id>.json, invoked as /workflow:<id>).
 * Multi-step scenarios for the chat agent: the agent follows the steps in one conversation and stops to
 * ask before a step marked `requiresApproval`. Different from .vibe/prompts/ (one request) and from
 * .vibe/pipelines.json (steps run by separate agents with their own role, tools and model).
 */
class VibeWorkflowService extends Disposable implements IVibeWorkflowService {
	declare readonly _serviceBrand: undefined;

	private readonly _onWorkflowRunRequested = this._register(new Emitter<{ workflowName: string; chatCommand: string }>());
	readonly onWorkflowRunRequested: Event<{ workflowName: string; chatCommand: string }> = this._onWorkflowRunRequested.event;

	/** Problems already logged: the list is read on every step of the agent loop, a file reports once. */
	private readonly _reported = new Set<string>();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	private _report(problem: string): void {
		if (!this._reported.has(problem)) {
			this._reported.add(problem);
			vibeLog.warn('vibeWorkflow', problem);
		}
	}

	async getWorkflows(): Promise<VibeWorkflow[]> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return []; }

		const dir = await this._fileService.resolve(joinPath(folders[0].uri, '.vibe', 'workflows')).catch(() => undefined);
		if (!dir?.children) { return []; }

		const workflows: VibeWorkflow[] = [];
		for (const child of dir.children) {
			const lower = child.name.toLowerCase();
			if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
				this._report(`.vibe/workflows/${child.name}: workflows are JSON files; this one is not read`);
				continue;
			}
			if (!lower.endsWith('.json')) { continue; }
			const id = child.name.slice(0, -'.json'.length);
			if (!isSlashCommandFileName(id)) {
				this._report(`.vibe/workflows/${child.name}: the name cannot follow /workflow: (letters, digits, "_", ".", "-"); not read`);
				continue;
			}
			try {
				const content = await this._fileService.readFile(child.resource);
				const parsed = parseWorkflowFile(content.value.toString(), id);
				if ('error' in parsed) {
					this._report(`.vibe/workflows/${child.name}: ${parsed.error}`);
				} else {
					workflows.push(parsed.workflow);
				}
			} catch (e) {
				this._report(`.vibe/workflows/${child.name}: unreadable (${e instanceof Error ? e.message : String(e)})`);
			}
		}
		return workflows;
	}

	async getWorkflow(id: string): Promise<VibeWorkflow | null> {
		const workflows = await this.getWorkflows();
		return workflows.find(w => w.id === id) ?? null;
	}

	async run(id: string): Promise<WorkflowRunResult> {
		const workflow = await this.getWorkflow(id);
		if (!workflow) {
			vibeLog.warn('vibeWorkflow', `[VibeWorkflow] run(): workflow "${id}" not found in .vibe/workflows/`);
			return { workflowName: id, chatMessage: null, dispatched: false };
		}

		const chatCommand = `/workflow:${workflow.id}`;
		this._onWorkflowRunRequested.fire({ workflowName: workflow.id, chatCommand });
		vibeLog.info('vibeWorkflow', `[VibeWorkflow] run(): dispatched "${chatCommand}" via event`);
		return { workflowName: workflow.id, chatMessage: chatCommand, dispatched: true };
	}
}

registerSingleton(IVibeWorkflowService, VibeWorkflowService, InstantiationType.Delayed);
