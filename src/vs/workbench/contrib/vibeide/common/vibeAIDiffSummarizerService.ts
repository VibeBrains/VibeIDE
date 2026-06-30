/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
export interface DiffSummary {
	branch?: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	summary: string;
	agentContext?: string; // From audit log: what agent did in this branch
	generatedAt: number;
}

export const IVibeAIDiffSummarizerService = createDecorator<IVibeAIDiffSummarizerService>('vibeAIDiffSummarizerService');

export interface IVibeAIDiffSummarizerService {
	readonly _serviceBrand: undefined;

	/**
	 * Generate a summary of diff changes.
	 * Phase 1: structured data from git. Phase 2: LLM-generated explanation.
	 */
	summarizeDiff(diff: string, branchName?: string): DiffSummary;

	/** Get summary with agent context from audit log */
	summarizeWithContext(diff: string, sessionId?: string): DiffSummary;
}

/**
 * VibeIDE AI Diff Summarizer.
 * "Before merge: explain what changed in this branch."
 * Uses audit log context for richer summaries.
 * Phase 1: structured git stats. Phase 2: LLM-generated explanation.
 */
class VibeAIDiffSummarizerService extends Disposable implements IVibeAIDiffSummarizerService {
	declare readonly _serviceBrand: undefined;

	summarizeDiff(diff: string, branchName?: string): DiffSummary {
		// Parse basic git diff stats
		const lines = diff.split('\n');
		const changedFiles = new Set<string>();
		let insertions = 0;
		let deletions = 0;

		for (const line of lines) {
			if (line.startsWith('diff --git')) {
				const match = line.match(/b\/(.+)$/);
				if (match) { changedFiles.add(match[1]); }
			} else if (line.startsWith('+') && !line.startsWith('+++')) {
				insertions++;
			} else if (line.startsWith('-') && !line.startsWith('---')) {
				deletions++;
			}
		}

		const summary = this._generateSummary(changedFiles, insertions, deletions, branchName);

		return {
			branch: branchName,
			filesChanged: changedFiles.size,
			insertions,
			deletions,
			summary,
			generatedAt: Date.now(),
		};
	}

	summarizeWithContext(diff: string, _sessionId?: string): DiffSummary {
		// Phase 1: same as summarizeDiff + note about audit context
		const base = this.summarizeDiff(diff);
		return {
			...base,
			agentContext: 'Audit log context integration available in Phase 2. Use vibe changelog --since <branch-base> for full AI/manual attribution.',
		};
	}

	private _generateSummary(files: Set<string>, insertions: number, deletions: number, branch?: string): string {
		const fileList = [...files].slice(0, 5).join(', ');
		const more = files.size > 5 ? ` and ${files.size - 5} more` : '';
		return [
			branch ? `Branch ${branch}:` : 'Changes:',
			`${files.size} files changed (${fileList}${more})`,
			`+${insertions} insertions, -${deletions} deletions`,
			`Phase 2: LLM-generated explanation will describe WHY these changes were made.`,
		].join('\n');
	}
}

registerSingleton(IVibeAIDiffSummarizerService, VibeAIDiffSummarizerService, InstantiationType.Eager);
