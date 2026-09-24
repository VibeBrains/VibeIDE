/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A text-slop check that a runaway project pattern cannot hang
 *
 * The runner executes one request under a time budget and answers `'timeout'` when it had to kill the work
 * On a timeout the check does not give up: it asks the shipped catalogue alone, finds the project rules that
 * cannot finish on this text one by one, and runs the project's catalogue without them — the rest of the
 * project's rules still count, and the ones left out are named
 */

import { SlopWorkerReply, SlopWorkerRequest } from './textSlopWorker.js';

export type SlopRunner = (request: SlopWorkerRequest) => Promise<SlopWorkerReply | 'timeout'>;

export interface SlopWatchdogOutcome extends SlopWorkerReply {
	/** Project rules left out of this check because they outlived the budget on it */
	readonly skippedRules: readonly string[];
}

/**
 * Run `request` through `runner`; `projectRuleIds` are the rules `.vibe/slop.json` brings, `budgetSeconds` is for the message
 * Worst case, one hanging rule costs two budgets: the whole catalogue and that rule alone
 */
export async function checkWithinBudget(runner: SlopRunner, request: SlopWorkerRequest, projectRuleIds: readonly string[], budgetSeconds: number): Promise<SlopWatchdogOutcome> {
	const full = await runner(request);
	if (full !== 'timeout') {
		return { ...full, skippedRules: [] };
	}
	const shippedRequest: SlopWorkerRequest = { texts: request.texts, ...(request.lexical ? { lexical: true } : {}) };
	const shipped = await runner(shippedRequest);
	if (shipped === 'timeout') {
		return {
			reports: undefined,
			warnings: [`Проверка нейрослопа не уложилась в ${budgetSeconds} с даже без правил проекта — текст не проверен`],
			skippedRules: [],
		};
	}
	if (request.overrides === undefined) {
		// Nothing of the project's to blame: the shipped catalogue answered, only the first attempt was unlucky.
		return { ...shipped, skippedRules: [] };
	}
	const culprits: string[] = [];
	for (const id of projectRuleIds) {
		if (await runner({ ...request, only: id }) === 'timeout') {
			culprits.push(id);
		}
	}
	const without = culprits.length > 0 ? await runner({ ...request, exclude: culprits }) : 'timeout';
	const reply = without === 'timeout' ? shipped : without;
	const left = culprits.length > 0 && without !== 'timeout' ? culprits : projectRuleIds;
	const warning = culprits.length > 0
		? `Правила ${left.join(', ')} из .vibe/slop.json не уложились в ${budgetSeconds} с на этом тексте (вероятно, катастрофический возврат в регулярке) — проверено без них`
		: `Правила .vibe/slop.json вместе не уложились в ${budgetSeconds} с на этом тексте — проверено без правил проекта`;
	return { reports: reply.reports, warnings: [...reply.warnings, warning], skippedRules: left };
}
