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
 */
const EFFORT_SCALE: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function effortWithinValues(stored: string | undefined, values: readonly string[], defaultValue: string): string {
	if (stored === undefined || values.includes(stored)) {
		return stored ?? defaultValue;
	}
	const storedRank = EFFORT_SCALE.indexOf(stored.toLowerCase());
	if (storedRank < 0) {
		return defaultValue;
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
