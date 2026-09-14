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
import { IVibeWorkflowService, VibeWorkflow } from './vibeWorkflowService.js';
import { IVibeSkillsLibraryService, VibeSkillEntry } from './vibeSkillsLibraryService.js';
import { IVibePromptGuardService } from './vibePromptGuardService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { describeSkillForApproval } from './skillApproval.js';
import { PROMPT_SLASH_COMMAND_NAMES, PromptSlashCommandName, isSlashCommandFileName } from './chatSlashCommands.js';
import { CONVENTIONAL_COMMIT_TYPES } from './conventionalCommitFormat.js';

/**
 * Pure helper — builds the raw expanded string for a skill expansion.
 * Exported so it can be tested without the DI container (smoke tests).
 */
export function buildSkillExpansion(skill: VibeSkillEntry, args?: string): string {
	const extra = args ? `\n\nAdditional context from user:\n${args}` : '';
	return `Follow this project Agent Skill (from ${skill.relativePath}):\n\n${skill.body}${extra}`;
}

/**
 * What `/commit` asks for: commit what is already staged, in the repository's own style; `--push`
 * pushes afterwards. Staging stays with the person — a commit of files nobody chose is not what was
 * asked for. The git commands go through run_command, so they are confirmed like any other command.
 */
export function buildCommitRequest(args: string): string {
	const words = args.split(/\s+/).filter(word => word.length > 0);
	const push = words.includes('--push');
	const note = words.filter(word => word !== '--push').join(' ');
	return [
		'Create a git commit from the changes that are already staged.',
		'1. Run `git diff --cached --stat` and `git diff --cached` via run_command to see what is staged. If nothing is staged, say so and stop: do not stage files unless the user asks.',
		'2. Run `git log -5 --format=%s` and follow the language and conventions of the existing commit messages.',
		`3. Write the message as a Conventional Commit: \`type(scope): subject\`, where type is one of ${CONVENTIONAL_COMMIT_TYPES.join(', ')}; the subject is imperative; add a short body when the change needs explaining.`,
		push
			? '4. Show the message, run `git commit` with it, then run `git push`.'
			: '4. Show the message, then run `git commit` with it.',
		...(note ? [`The user's note about this commit: ${note}`] : []),
	].join('\n');
}

/**
 * What `/workflow:<name>` asks for: the whole scenario — every step, its instructions and the stops
 * where the person must approve. The agent follows the steps in one conversation; steps with their own
 * role, tools and model are what pipelines (`.vibe/pipelines.json`) are for.
 */
export function buildWorkflowExpansion(workflow: VibeWorkflow): string {
	const steps = workflow.steps.map((step, i) => {
		const lines = [`${i + 1}. ${step.name}${step.description ? `: ${step.description}` : ''}`];
		if (step.prompt) {
			lines.push(`   Instructions: ${step.prompt}`);
		}
		if (step.requiresApproval) {
			lines.push('   Before starting this step, stop and ask the user for approval.');
		}
		return lines.join('\n');
	});
	const head = `Execute workflow "${workflow.name}"${workflow.description ? `: ${workflow.description}` : ''}`;
	return `${head}\n\nSteps:\n${steps.join('\n')}\n\nWork through the steps in order.`;
}

/**
 * The block a prompt command becomes at the head of the user turn — where `/skill:` bodies go, and for
 * the same reason: guidance in the system prompt is read as standing rules, not as this request
 * (modelStalls.md #002). When the file behind `/my:` or `/workflow:` is missing, the model is told to
 * say so rather than guess what the command meant.
 */
export function buildCommandInvocationBlock(command: string, expanded: string | null): string {
	if (expanded !== null) {
		return `The user invoked /${command}. The block below is the request itself; text after the command in the user's message adds to it.\n\n<command_invocation name="${command}">\n${expanded}\n</command_invocation>`;
	}
	const colon = command.indexOf(':');
	if (colon < 0) {
		return '';
	}
	const name = command.slice(colon + 1);
	const file = command.startsWith('workflow:') ? `.vibe/workflows/${name}.json` : `.vibe/prompts/${name}.md`;
	return `The user typed /${command}, but ${file} does not exist in this project. Say so in one sentence, then answer the rest of the message, if there is any.`;
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

/** A built-in prompt command: what the menu says about it and what it asks of the model. */
interface BuiltinPromptCommand {
	readonly description: string;
	readonly execute: (args: string) => string;
}

// Built-in prompt commands, keyed by the shared name list in chatSlashCommands.ts: a name without a
// template does not compile.
const BUILTIN_PROMPTS: Record<PromptSlashCommandName, BuiltinPromptCommand> = {
	fix: {
		description: localize('vibeide.slash.fix.desc', 'Исправить текущую ошибку или проблему'),
		execute: (args) => `Fix the following issue: ${args || 'Fix all errors in the current file'}. Explain what was wrong and how you fixed it.`,
	},
	tests: {
		description: localize('vibeide.slash.tests.desc', 'Написать тесты для текущего кода'),
		execute: (args) => `Write comprehensive tests for ${args || 'the current file'}. Include happy path, edge cases, and error cases.`,
	},
	explain: {
		description: localize('vibeide.slash.explain.desc', 'Объяснить текущий код'),
		execute: (args) => `Explain ${args || 'the current file'} in clear language. Describe what it does, how it works, and any important patterns.`,
	},
	refactor: {
		description: localize('vibeide.slash.refactor.desc', 'Рефакторинг для ясности и производительности'),
		execute: (args) => `Refactor ${args || 'this code'} for clarity, performance, and maintainability. Follow best practices. Explain your changes.`,
	},
	review: {
		description: localize('vibeide.slash.review.desc', 'Код-ревью с рекомендациями'),
		execute: (args) => `Review ${args || 'this code'} for bugs, security issues, performance problems, and style. Provide actionable suggestions.`,
	},
	docs: {
		description: localize('vibeide.slash.docs.desc', 'Добавить документацию / комментарии'),
		execute: (args) => `Add clear documentation and comments to ${args || 'this code'}. Use the appropriate doc format (JSDoc, docstring, etc.).`,
	},
	simplify: {
		description: localize('vibeide.slash.simplify.desc', 'Ревью диффа на оверинжиниринг: делит-лист'),
		execute: (args) => `Review ${args || 'the current git diff'} for over-engineering. ${args ? '' : 'First run \`git diff HEAD\` via run_command (fall back to \`git diff\` / \`git show HEAD\` if empty) to get the changes. '}\
Walk the minimalism ladder over every addition: does it need to exist at all (YAGNI); does the codebase, stdlib, platform, or an installed dependency already do it; could it be smaller.
Return a DELETE-LIST: for each finding — file:line, what to delete or simplify, why, and the estimated lines saved. Order by lines saved, largest first. Do NOT change any files — this is a review.
Skip findings that would trim validation, error handling, security, or accessibility. If the diff is already minimal, say so briefly instead of inventing findings.`,
	},
	commit: {
		description: localize('vibeide.slash.commit.desc', "Закоммитить застейдженное: сообщение по Conventional Commits, с --push — и запушить"),
		execute: buildCommitRequest,
	},
};

const BUILTIN_COMMANDS: readonly SlashCommand[] = PROMPT_SLASH_COMMAND_NAMES.map((name): SlashCommand => ({ name, category: 'builtin', ...BUILTIN_PROMPTS[name] }));

/**
 * VibeIDE Slash Commands Service — the commands that are prompts for the model.
 * Built-in: /fix, /tests, /explain, /refactor, /review, /docs, /simplify, /commit
 * User prompts: /my:<file name> (.vibe/prompts/<file name>.md)
 * Workflows: /workflow:<file name> (.vibe/workflows/<file name>.json)
 * Agent skills: /skill:skill-id (from .vibe/skills/.../SKILL.md)
 * The request builder (convertToLLMMessageService) expands them into the user turn; the commands the
 * IDE runs itself (/watch, /shot) never get here — see chatSlashCommands.ts.
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

		// User prompts as /my:name. A file whose name cannot follow the colon is not offered: picking it
		// would insert a command that does not parse.
		const prompts = await this._promptLibrary.getPrompts();
		for (const p of prompts) {
			if (isSlashCommandFileName(p.name)) {
				commands.push({ name: `my:${p.name}`, description: p.content.split('\n')[0].replace(/^#\s*/, ''), category: 'prompt' });
			}
		}

		// Workflows as /workflow:<file name>
		const workflows = await this._workflowService.getWorkflows();
		workflows.forEach(w => commands.push({
			name: `workflow:${w.id}`,
			description: w.description || w.name,
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

		// Workflow: /workflow:<file name>
		if (cmdName.startsWith('workflow:')) {
			const workflowId = cmdName.slice('workflow:'.length);
			const workflow = await this._workflowService.getWorkflow(workflowId);
			if (workflow) {
				return this._sanitizeExpanded(buildWorkflowExpansion(workflow), `.vibe/workflows/${workflowId}.json`);
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
