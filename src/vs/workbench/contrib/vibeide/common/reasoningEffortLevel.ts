/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A stored reasoning effort, brought inside the levels the selected model accepts.
 *
 * WHY: the level is stored per model selection and outlives the list it was chosen from — a model
 * entry edited in `providers.json`, a level picked before the vendor renamed its scale. It used to go
 * on the wire as stored, and DeepSeek answers an unknown level with HTTP 400 (`unknown variant`,
 * checked live 14.09.2026); the slider meanwhile drew «off» for a level it could not find.
 *
 * The scale is the union of vendor vocabularies in order of effort. A level the model lacks moves to the
 * nearest one it has; on a tie the higher wins, which is how vendors fold their own scales (DeepSeek:
 * `medium` → `high`). A word that is on no scale at all says nothing about distance, so it becomes the
 * model's default.
 *
 * An intensifier folds to the level it intensifies, tie or not: `xhigh` is «high, but more», `ultra` is
 * «max, but more». DeepSeek's own table says exactly that — `xhigh → high`, `ultra → max`
 * (api-docs.deepseek.com/guides/thinking_mode, checked 18.09.2026) — and the tie rule alone would have
 * sent `xhigh` up to `max`, where the user pays the top rate for a level they did not pick.
 */
const EFFORT_SCALE: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Levels that are a named level plus emphasis — they fold back to that level when the model lacks them. */
const INTENSIFIER_BASE: Record<string, string> = { xhigh: 'high', ultra: 'max' };

export function effortWithinValues(stored: string | undefined, values: readonly string[], defaultValue: string): string {
	if (stored === undefined || values.includes(stored)) {
		return stored ?? defaultValue;
	}
	const lowered = stored.toLowerCase();
	const storedRank = EFFORT_SCALE.indexOf(lowered);
	if (storedRank < 0) {
		return defaultValue;
	}
	const base = INTENSIFIER_BASE[lowered];
	if (base !== undefined) {
		const offered = values.find(value => value.toLowerCase() === base);
		if (offered !== undefined) {
			return offered;
		}
	}
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	let bestRank = -1;
	for (const value of values) {
		const rank = EFFORT_SCALE.indexOf(value.toLowerCase());
		if (rank < 0) {
			continue;
		}
		const distance = Math.abs(rank - storedRank);
		if (distance < bestDistance || (distance === bestDistance && rank > bestRank)) {
			best = value;
			bestDistance = distance;
			bestRank = rank;
		}
	}
	return best ?? defaultValue;
}
