/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { DiffChunk } from './vibeDiffPreviewService.js';

export interface JudgeVerdict {
	chunkId: string;
	verdict: 'looks_ok' | 'potential_issue' | 'security_concern';
	message: string;
	isAdvisory: boolean; // NEVER changes confidence score — only adds advisory badge
}

export const IVibeLLMJudgeService = createDecorator<IVibeLLMJudgeService>('vibeLLMJudgeService');

export interface IVibeLLMJudgeService {
	readonly _serviceBrand: undefined;

	/**
	 * Second pass review of diff chunks by a cheap model.
	 * IMPORTANT: Judge is ADVISORY ONLY — it CANNOT change confidence score.
	 * 🔴 confidence blocks Auto mode REGARDLESS of judge verdict.
	 * Two independent badges in UI: Confidence + Judge.
	 */
	reviewChunk(chunk: DiffChunk): Promise<JudgeVerdict>;

	/**
	 * Lightweight heuristic review of persisted agent plan text (summary + steps).
	 * Advisory only — does not block execution.
	 */
	reviewPlanHeuristic(planText: string): JudgeVerdict;
}

/**
 * VibeIDE LLM-as-judge Diff Review.
 * Second pass on each diff chunk by a cheap model (haiku/flash).
 * Advisory badge only — NEVER overrides Diff confidence score.
 *
 * CRITICAL RULE (from docs/v1/transparency/control.md):
 * - Confidence score = independent heuristic (keywords, file path)
 * - Judge = separate advisory (can say "looks ok" or "has issue")
 * - Judge CANNOT change confidence score
 * - 🔴 confidence ALWAYS blocks Auto mode regardless of judge
 */
class VibeLLMJudgeService extends Disposable implements IVibeLLMJudgeService {
	declare readonly _serviceBrand: undefined;

	private static readonly _CODE_SECURITY: readonly RegExp[] = [
		/eval\s*\(/, /exec\s*\(/, /subprocess\s*\(/, /os\.system/,
		/innerHTML\s*=/, /document\.write\s*\(/,
		/sql.*=.*\+.*input/i, /query.*=.*\+.*user/i,
	];

	private static readonly _PLAN_RISK: ReadonlyArray<readonly [RegExp, string]> = [
		[/git\s+push\s+--force/, 'Judge: plan mentions git force-push'],
		[/\brm\s+-rf\b/, 'Judge: plan mentions recursive delete (rm -rf)'],
		[/\bdrop\s+table\b/i, 'Judge: plan mentions DROP TABLE'],
		[/\bkubectl\s+delete\b/, 'Judge: plan mentions kubectl delete'],
		[/chmod\s+[^\n]*\+x/i, 'Judge: plan mentions making binaries executable'],
		[/curl\s+[^\n]*\|\s*(ba)?sh/i, 'Judge: plan mentions piping curl into shell'],
		[/wget\s+[^\n]*\|\s*(ba)?sh/i, 'Judge: plan mentions piping wget into shell'],
	];

	constructor(
	) {
		super();
	}

	async reviewChunk(chunk: DiffChunk): Promise<JudgeVerdict> {
		// Phase 1: keyword-based advisory (no LLM call needed, fast)
		// Phase 2: actual cheap LLM call (haiku/flash)

		const content = chunk.newLines.join('\n').toLowerCase();
		const sec = this._firstCodeSecurityIssue(content);
		if (sec) {
			const verdict = { ...sec, chunkId: chunk.id };
			vibeLog.debug('LLMJudge', `chunk ${chunk.id}: ${verdict.verdict}`);
			return verdict;
		}

		if (chunk.confidence === 'red') {
			const verdict: JudgeVerdict = {
				chunkId: chunk.id,
				verdict: 'potential_issue',
				message: 'Judge: high-risk change detected by heuristics',
				isAdvisory: true,
			};
			vibeLog.debug('LLMJudge', `chunk ${chunk.id}: ${verdict.verdict}`);
			return verdict;
		}

		const verdict: JudgeVerdict = {
			chunkId: chunk.id,
			verdict: 'looks_ok',
			message: 'Judge: no obvious issues detected (Phase 2: full LLM review)',
			isAdvisory: true,
		};
		vibeLog.debug('LLMJudge', `chunk ${chunk.id}: ${verdict.verdict}`);
		return verdict;
	}

	reviewPlanHeuristic(planText: string): JudgeVerdict {
		const content = planText.toLowerCase();
		const sec = this._firstCodeSecurityIssue(content);
		if (sec) {
			return { ...sec, chunkId: 'plan' };
		}
		for (const [pattern, message] of VibeLLMJudgeService._PLAN_RISK) {
			if (pattern.test(content)) {
				return { chunkId: 'plan', verdict: 'potential_issue', message, isAdvisory: true };
			}
		}
		return {
			chunkId: 'plan',
			verdict: 'looks_ok',
			message: 'Judge: no obvious high-risk patterns in plan text',
			isAdvisory: true,
		};
	}

	private _firstCodeSecurityIssue(content: string): JudgeVerdict | null {
		for (const pattern of VibeLLMJudgeService._CODE_SECURITY) {
			if (pattern.test(content)) {
				return {
					chunkId: '',
					verdict: 'security_concern',
					message: `Judge: potential security pattern detected (${pattern.source.slice(0, 20)}...)`,
					isAdvisory: true,
				};
			}
		}
		return null;
	}
}

registerSingleton(IVibeLLMJudgeService, VibeLLMJudgeService, InstantiationType.Delayed);
