/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

import { IVibePromptLibraryService } from './vibePromptLibraryService.js';
import { IVibeWorkflowService } from './vibeWorkflowService.js';
import { IVibeSkillsLibraryService, VibeSkillEntry } from './vibeSkillsLibraryService.js';
import { IVibePromptGuardService } from './vibePromptGuardService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { describeSkillForApproval } from './skillApproval.js';

/**
 * Pure helper — builds the raw expanded string for a skill expansion.
 * Exported so it can be tested without the DI container (smoke tests).
 */
export function buildSkillExpansion(skill: VibeSkillEntry, args?: string): string {
	const extra = args ? `\n\nAdditional context from user:\n${args}` : '';
	return `Follow this project Agent Skill (from ${skill.relativePath}):\n\n${skill.body}${extra}`;
}

export interface SlashCommand {
	name: string;       // e.g., "fix", "tests", "my:review"
	description: string;
	category: 'builtin' | 'prompt' | 'workflow' | 'skill';
	execute?: (args: string) => string; // Returns prompt text
}

export const IVibeSlashCommandService = createDecorator<IVibeSlashCommandService>('vibeSlashCommandService');

export interface IVibeSlashCommandService {
	readonly _serviceBrand: undefined;

	/** Get all available slash commands */
	getCommands(): Promise<SlashCommand[]>;

	/** Expand a slash command to prompt text */
	expand(command: string, args?: string): Promise<string | null>;

	/** Check if input starts with a slash command */
	isSlashCommand(input: string): boolean;
}

// Built-in slash commands
const BUILTIN_COMMANDS: SlashCommand[] = [
	{
		name: 'fix',
		description: localize('vibeide.slash.fix.desc', 'Исправить текущую ошибку или проблему'),
		category: 'builtin',
		execute: (args) => `Fix the following issue: ${args || 'Fix all errors in the current file'}. Explain what was wrong and how you fixed it.`,
	},
	{
		name: 'tests',
		description: localize('vibeide.slash.tests.desc', 'Написать тесты для текущего кода'),
		category: 'builtin',
		execute: (args) => `Write comprehensive tests for ${args || 'the current file'}. Include happy path, edge cases, and error cases.`,
	},
	{
		name: 'explain',
		description: localize('vibeide.slash.explain.desc', 'Объяснить текущий код'),
		category: 'builtin',
		execute: (args) => `Explain ${args || 'the current file'} in clear language. Describe what it does, how it works, and any important patterns.`,
	},
	{
		name: 'refactor',
		description: localize('vibeide.slash.refactor.desc', 'Рефакторинг для ясности и производительности'),
		category: 'builtin',
		execute: (args) => `Refactor ${args || 'this code'} for clarity, performance, and maintainability. Follow best practices. Explain your changes.`,
	},
	{
		name: 'review',
		description: localize('vibeide.slash.review.desc', 'Код-ревью с рекомендациями'),
		category: 'builtin',
		execute: (args) => `Review ${args || 'this code'} for bugs, security issues, performance problems, and style. Provide actionable suggestions.`,
	},
	{
		name: 'docs',
		description: localize('vibeide.slash.docs.desc', 'Добавить документацию / комментарии'),
		category: 'builtin',
		execute: (args) => `Add clear documentation and comments to ${args || 'this code'}. Use the appropriate doc format (JSDoc, docstring, etc.).`,
	},
	{
		name: 'simplify',
		description: localize('vibeide.slash.simplify.desc', 'Ревью диффа на оверинжиниринг: делит-лист'),
		category: 'builtin',
		execute: (args) => `Review ${args || 'the current git diff'} for over-engineering. ${args ? '' : 'First run \`git diff HEAD\` via run_command (fall back to \`git diff\` / \`git show HEAD\` if empty) to get the changes. '}\
Walk the minimalism ladder over every addition: does it need to exist at all (YAGNI); does the codebase, stdlib, platform, or an installed dependency already do it; could it be smaller.
Return a DELETE-LIST: for each finding — file:line, what to delete or simplify, why, and the estimated lines saved. Order by lines saved, largest first. Do NOT change any files — this is a review.
Skip findings that would trim validation, error handling, security, or accessibility. If the diff is already minimal, say so briefly instead of inventing findings.`,
	},
];

/**
 * VibeIDE Slash Commands Service.
 * Built-in: /fix, /tests, /explain, /refactor, /review, /docs, /simplify
 * User prompts: /my:template-name
 * Workflows: /workflow:name
 * Agent skills: /skill:skill-id (from .vibe/skills/.../SKILL.md)
 */
export class VibeSlashCommandService extends Disposable implements IVibeSlashCommandService {
	declare readonly _serviceBrand: undefined;

	/**
	 * Skill versions the person refused in this window. The chat asks for the expansion on every
	 * step of the agent loop; without this a refusal would come back as the same dialog each step.
	 */
	private readonly _declined = new Set<string>();

	constructor(
		@IVibePromptLibraryService private readonly _promptLibrary: IVibePromptLibraryService,
		@IVibeWorkflowService private readonly _workflowService: IVibeWorkflowService,
		@IVibeSkillsLibraryService private readonly _skillsLibrary: IVibeSkillsLibraryService,
		@IVibePromptGuardService private readonly _promptGuard: IVibePromptGuardService,
		@IDialogService private readonly _dialogService: IDialogService,
	) {
		super();
	}

	/**
	 * Asks before a skill the person has not approved reaches the model — the dependencies it pulls
	 * in included, since their text reaches the model just the same. Approving here approves these
	 * files as they are now; any later change asks again.
	 */
	private async _confirmSkillsForUse(chain: readonly VibeSkillEntry[]): Promise<boolean> {
		const pending = chain.filter(skill => !this._skillsLibrary.isSkillAvailableToModel(skill));
		if (pending.length === 0) {
			return true;
		}
		const version = pending.map(skill => `${skill.package?.root.toString() ?? skill.skillId}#${skill.package?.digest ?? ''}`).join('|');
		if (this._declined.has(version)) {
			return false;
		}
		const described = pending.map(skill => skill.package ? describeSkillForApproval(skill.skillId, skill.package) : `«${skill.skillId}»`);
		if (pending.some(skill => !skill.package?.digest)) {
			this._declined.add(version);
			await this._dialogService.info(
				localize('vibeide.skills.use.cannotApprove', "Скилл нельзя одобрить: отпечаток его файлов не снят"),
				described.join('\n\n'),
			);
			return false;
		}
		const { confirmed } = await this._dialogService.confirm({
			type: 'warning',
			message: pending.length === 1
				? localize('vibeide.skills.use.one', "Скилл «{0}» ещё не одобрен", pending[0].skillId)
				: localize('vibeide.skills.use.many', "Скиллы ещё не одобрены: {0}", pending.map(skill => skill.skillId).join(', ')),
			detail: [...described, localize('vibeide.skills.use.note', "Одобряются именно эти файлы: любая их правка снова спросит разрешения.")].join('\n\n'),
			primaryButton: localize('vibeide.skills.use.approve', "Одобрить и использовать"),
		});
		if (!confirmed) {
			this._declined.add(version);
			return false;
		}
		await this._skillsLibrary.approveSkills(pending);
		return true;
	}

	private _sanitizeExpanded(text: string, virtualPath: string): string {
		return this._promptGuard.sanitizeFileContent(text, virtualPath).sanitized;
	}

	async getCommands(): Promise<SlashCommand[]> {
		const commands: SlashCommand[] = [...BUILTIN_COMMANDS];

		// Add user prompts as /my:name
		const prompts = await this._promptLibrary.getPrompts();
		prompts.forEach(p => commands.push({
			name: `my:${p.name}`,
			description: p.content.split('\n')[0].replace(/^#\s*/, ''),
			category: 'prompt',
		}));

		// Add workflows as /workflow:name
		const workflows = await this._workflowService.getWorkflows();
		workflows.forEach(w => commands.push({
			name: `workflow:${w.name}`,
			description: w.description,
			category: 'workflow',
		}));

		// Add agent skills as /skill:id
		const skills = await this._skillsLibrary.getSkills();
		skills.forEach(s => commands.push({
			name: `skill:${s.skillId}`,
			description: s.description || s.title,
			category: 'skill',
		}));

		return commands;
	}

	async expand(command: string, args: string = ''): Promise<string | null> {
		const cmdName = command.startsWith('/') ? command.slice(1) : command;

		// Built-in command
		const builtin = BUILTIN_COMMANDS.find(c => c.name === cmdName);
		if (builtin?.execute) {
			return builtin.execute(args);
		}

		// User prompt: /my:name
		if (cmdName.startsWith('my:')) {
			const promptName = cmdName.slice(3);
			const prompt = await this._promptLibrary.getPrompt(promptName);
			if (prompt) {
				const rendered = this._promptLibrary.render(prompt.content, { ARGS: args });
				return this._sanitizeExpanded(rendered, `.vibe/prompts/${promptName}.md`);
			}
		}

		// Workflow: /workflow:name
		if (cmdName.startsWith('workflow:')) {
			const workflowName = cmdName.slice(9);
			const workflow = await this._workflowService.getWorkflow(workflowName);
			if (workflow) {
				const raw = `Execute workflow "${workflow.name}": ${workflow.description}\n\nSteps:\n${workflow.steps.map((s, i) => `${i + 1}. ${s.name}: ${s.description}`).join('\n')}`;
				return this._sanitizeExpanded(raw, `.vibe/workflows/${workflowName}.md`);
			}
		}

		// Agent skill: /skill:id
		if (cmdName.startsWith('skill:')) {
			const skillId = cmdName.slice(6);
			const skill = await this._skillsLibrary.getSkill(skillId);
			if (skill) {
				const depIds = await this._skillsLibrary.resolveDependencies(skill.skillId);
				const deps: VibeSkillEntry[] = [];
				for (const depId of depIds) {
					const dep = await this._skillsLibrary.getSkill(depId);
					if (dep) {
						deps.push(dep);
					}
				}
				if (!(await this._confirmSkillsForUse([...deps, skill]))) {
					return null;
				}
				const chunks = [...deps.map(dep => buildSkillExpansion(dep)), buildSkillExpansion(skill, args)];
				const merged = chunks.join('\n\n---\n\n');
				return this._sanitizeExpanded(merged, skill.relativePath);
			}
		}

		vibeLog.warn('SlashCommands', `Unknown command: ${command}`);
		return null;
	}

	isSlashCommand(input: string): boolean {
		return input.trimStart().startsWith('/');
	}
}

registerSingleton(IVibeSlashCommandService, VibeSlashCommandService, InstantiationType.Delayed);
