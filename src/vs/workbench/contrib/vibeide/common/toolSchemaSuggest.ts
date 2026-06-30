/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure helper for cross-tool argument suggestion (X.11.4 / X.13.7 / X.14).
 *
 * Extracted to common-layer so it can be unit-tested without pulling in the
 * full chatThreadService / builtinTools surface. The browser-side wrapper in
 * `chatThreadService.ts` adapts the project's tool catalog through
 * `classifyParams` and feeds candidates into these pure functions.
 *
 * Algorithm: score each candidate by `|rawKeys ∩ candidateRequired| /
 * |candidateRequired|`. A perfect match → 1.0. Best candidate wins if its
 * score >= `minScore` (default 0.6) AND strictly better than the called
 * tool's self-score (so we don't suggest the same tool back when one
 * required param is wrong).
 */

export interface ToolParamSpec {
	readonly required: readonly string[];
}

export interface ToolCandidate {
	readonly name: string;
	readonly params: ToolParamSpec;
}

/**
 * X.11.4 — direct param-name → tool hints. Some param names are
 * unambiguously associated with a specific tool. If the model called the
 * wrong tool but passed a hint-param, we can suggest the right tool even
 * before scoring kicks in (handles 0% score cases where the called tool
 * wouldn't get suggested via shape-match).
 *
 * Observed incident 2026-05-23 (minimax-m2.7): model called `read_file`
 * with `{nl_input: ...}` — `nl_input` is the strong-signal hint for
 * `run_nl_command`.
 *
 * Add entries here as observed in production. Keep it conservative —
 * a wrong hint loops the model.
 */
export const CROSS_TOOL_ARG_HINTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	nl_input: ['run_nl_command', 'nl_shell'],
	natural_language_input: ['run_nl_command', 'nl_shell'],
	shell_command: ['terminal_command', 'run_terminal_command'],
	bash: ['terminal_command', 'run_terminal_command'],
	terminal: ['terminal_command', 'run_terminal_command'],
});

/**
 * Returns the first hinted tool whose name is in the `availableNames` set,
 * or null if no rawParamKey carries a strong hint. Used as a fast-path
 * before the score-based heuristic — direct evidence > shape inference.
 */
export const suggestByArgHints = (
	rawParamKeys: readonly string[],
	availableNames: ReadonlySet<string>,
): string | null => {
	for (const key of rawParamKeys) {
		const candidates = CROSS_TOOL_ARG_HINTS[key.toLowerCase()];
		if (!candidates) { continue; }
		for (const candidate of candidates) {
			if (availableNames.has(candidate)) { return candidate; }
		}
	}
	return null;
};

/**
 * Fraction of `requiredParams` present (case-insensitive) in `rawKeys`.
 * Returns 0 when `requiredParams` is empty (no required → no signal).
 */
export const scoreToolMatch = (
	requiredParams: readonly string[],
	rawKeys: readonly string[],
): number => {
	if (requiredParams.length === 0) { return 0; }
	const rawSet = new Set(rawKeys.map(k => k.toLowerCase()));
	let hits = 0;
	for (const required of requiredParams) {
		if (rawSet.has(required.toLowerCase())) { hits += 1; }
	}
	return hits / requiredParams.length;
};

/**
 * Returns name of the candidate whose required-param shape best matches
 * `rawParamKeys`, OR null if no candidate clears the bar.
 *
 * - `minScore` (default 0.6): floor for considering a candidate at all.
 * - The called tool's self-score acts as a second floor — candidates must
 *   beat it strictly. Prevents «one-required-param-typo» from being
 *   misclassified as cross-tool confusion.
 */
export const suggestAlternateTool = (
	calledTool: ToolCandidate,
	candidates: readonly ToolCandidate[],
	rawParamKeys: readonly string[],
	minScore: number = 0.6,
): string | null => {
	if (rawParamKeys.length === 0) { return null; }
	// X.11.4 — direct hint short-circuit. If any rawParamKey is a known
	// strong signal for a specific tool, return it without scoring. Beats
	// the shape-match algorithm when called tool's required params don't
	// appear at all (shape match would return null, hint catches it).
	const availableNames = new Set(candidates.map(c => c.name));
	availableNames.add(calledTool.name);
	const hinted = suggestByArgHints(rawParamKeys, availableNames);
	if (hinted && hinted !== calledTool.name) { return hinted; }
	const calledScore = scoreToolMatch(calledTool.params.required, rawParamKeys);
	let best: { name: string; score: number; required: number } | null = null;
	for (const candidate of candidates) {
		if (candidate.name === calledTool.name) { continue; }
		if (candidate.params.required.length === 0) { continue; }
		const score = scoreToolMatch(candidate.params.required, rawParamKeys);
		if (score < minScore) { continue; }
		if (score <= calledScore) { continue; }
		const required = candidate.params.required.length;
		// Tie-break: equal score → prefer the more specific candidate (covers more
		// required params), so a tool whose full shape is used wins over one whose
		// shape is a strict subset of the raw keys.
		if (!best || score > best.score || (score === best.score && required > best.required)) {
			best = { name: candidate.name, score, required };
		}
	}
	return best?.name ?? null;
};
