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
];

/**
 * VibeIDE Slash Commands Service.
 * Built-in: /fix, /tests, /explain, /refactor, /review, /docs
 * User prompts: /my:template-name
 * Workflows: /workflow:name
 * Agent skills: /skill:skill-id (from .vibe/skills/.../SKILL.md)
 */
class VibeSlashCommandService extends Disposable implements IVibeSlashCommandService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IVibePromptLibraryService private readonly _promptLibrary: IVibePromptLibraryService,
		@IVibeWorkflowService private readonly _workflowService: IVibeWorkflowService,
		@IVibeSkillsLibraryService private readonly _skillsLibrary: IVibeSkillsLibraryService,
		@IVibePromptGuardService private readonly _promptGuard: IVibePromptGuardService,
	) {
		super();
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
				const chunks: string[] = [];
				for (const depId of depIds) {
					const dep = await this._skillsLibrary.getSkill(depId);
					if (dep) {
						chunks.push(buildSkillExpansion(dep));
					}
				}
				chunks.push(buildSkillExpansion(skill, args));
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
