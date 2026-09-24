/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CollectedDiff } from '../vibeideSCMTypes.js';
import type { PipelineStepOutcome, VibePipelineStep } from './vibePipelineFile.js';

/**
 * The run's diff for the steps that judge work.
 *
 * A judging role reads files, but it has no git: it sees how the files are now and not what they were, so a
 * review of «the changes» was a review of the finished text with no way to tell a draft from its edit. The
 * pipeline therefore pins the working tree before its first step and hands a judge the diff from there —
 * new and deleted files included, the files the agent may not read left out, secrets masked.
 *
 * The figures are VibeIDEA's (its `pipelinesSpec.md`, «Шаг на своей модели»): the shared `pipelines.json`
 * runs in both products and should cost a judge the same there as here.
 */

/**
 * Roles that judge work rather than make it. `orchestrator` is read-only too, but it routes work — the
 * list is the family's own (VibeIDEA names the same five as the roles that write nothing).
 */
export const JUDGING_ROLES: ReadonlySet<string> = new Set(['explore', 'planner', 'code-reviewer', 'security', 'critic']);

/** The diff budget of a step with no token ceiling, in characters. */
export const RUN_DIFF_DEFAULT_CHARS = 40_000;

/** Characters per token in the budget estimate — the same rough four the subagent quota uses. */
const CHARS_PER_TOKEN = 4;

/**
 * How much diff a step gets: half of its token ceiling, or `RUN_DIFF_DEFAULT_CHARS` without one. Half,
 * because the other half is what the step needs to read files and answer.
 */
export function runDiffBudgetChars(maxTokens: number | undefined): number {
	return maxTokens !== undefined && maxTokens > 0 ? Math.floor(maxTokens / 2) * CHARS_PER_TOKEN : RUN_DIFF_DEFAULT_CHARS;
}

/**
 * Whether the step takes the run's diff once something has run before it: a judging role that did not
 * ask for fresh eyes. `ignorePreviousArtifacts` turns the diff off with the rest of the inheritance —
 * the field means the same in both products.
 */
export function wantsRunDiff(step: Pick<VibePipelineStep, 'role' | 'ignorePreviousArtifacts'>): boolean {
	return JUDGING_ROLES.has(step.role) && !step.ignorePreviousArtifacts;
}

/** Whether the step is handed the run's diff now: it wants one, and something has run before it. */
export function receivesRunDiff(step: Pick<VibePipelineStep, 'role' | 'ignorePreviousArtifacts'>, previous: readonly PipelineStepOutcome[]): boolean {
	return wantsRunDiff(step) && previous.length > 0;
}

/**
 * The block a judge reads: whole files first, cut at a file boundary when the budget runs out and marked
 * then, so the step knows it does not see everything. When the very first file is larger than the
 * budget, its beginning is shown, cut at a line.
 */
export function composeDiffBlock(kind: 'run' | 'step', diff: CollectedDiff, budgetChars: number): string {
	const title = kind === 'run'
		? 'Дифф прогона — что изменилось в проекте с начала пайплайна, новые и удалённые файлы тоже'
		: 'Дифф шага — что изменил проверяемый шаг';
	if (diff.unavailable) {
		return `${title}: недоступен — ${diff.unavailable}.`;
	}
	if (diff.sections.length === 0) {
		return diff.hidden > 0
			? `${title}: изменения есть только в файлах, закрытых для агента правилами чтения (${diff.hidden}).`
			: `${title}: изменений нет.`;
	}
	const shown: string[] = [];
	let used = 0;
	let firstCut = false;
	for (const section of diff.sections) {
		if (used + section.length <= budgetChars) {
			shown.push(section);
			used += section.length;
			continue;
		}
		if (shown.length === 0) {
			shown.push(cutAtLine(section, budgetChars));
			firstCut = true;
		}
		break;
	}
	const text = shown.join('').replace(/\n+$/, '');
	const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
	const notes: string[] = [];
	if (shown.length < diff.files || firstCut) {
		notes.push(`Дифф обрезан по объёму: показано файлов ${shown.length} из ${diff.files}${firstCut ? ', и первый не целиком' : ''} — остальное прочитайте по путям сами.`);
	}
	if (diff.hidden > 0) {
		notes.push(`Файлов, закрытых для агента правилами чтения, в диффе нет: ${diff.hidden}.`);
	}
	return [`${title}:`, `${fence}diff`, text, fence, ...notes].join('\n');
}

/** The beginning of `text`, at most `max` characters, ending at a line break when there is one. */
function cutAtLine(text: string, max: number): string {
	const head = text.slice(0, Math.max(0, max));
	const lineEnd = head.lastIndexOf('\n');
	return lineEnd > 0 ? head.slice(0, lineEnd + 1) : head;
}

/** The fence must be longer than any run of backticks inside, or a diff of a Markdown file would close it. */
function longestBacktickRun(text: string): number {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) {
		longest = Math.max(longest, run.length);
	}
	return longest;
}
