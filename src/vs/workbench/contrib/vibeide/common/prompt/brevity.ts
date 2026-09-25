/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * «Краткие ответы»: the agent answers tersely, keeping every technical fact.
 *
 * The rules are adapted from the caveman skill by Julius Brussee (github.com/juliusbrussee/caveman,
 * plugins/caveman/skills/caveman/SKILL.md), which is MIT-licensed; the notice is in ThirdPartyNotices.txt.
 * The classical-Chinese levels are left out: they compress characters, not meaning, for readers this product has not.
 * The name «Caveman» is its author's trademark, so the mode carries a name of its own.
 *
 * The block rides in the stable system prompt, not in each message: repeated per message it would cost
 * the very tokens the mode saves. A change of level changes the prompt, so it is part of the prompt's cache key.
 * Pure: a level in, prompt text out.
 */

export type BrevityLevel = 'off' | 'lite' | 'full' | 'ultra';

export const BREVITY_LEVELS: readonly BrevityLevel[] = ['off', 'lite', 'full', 'ultra'];

/** On from the start: the terse style is the product's default, the full one is a choice */
export const DEFAULT_BREVITY_LEVEL: BrevityLevel = 'full';

export const BREVITY_SETTING = 'vibeide.chat.brevity';

/** The setting's value, or the default for anything else — a typo must not switch the mode off in silence */
export function brevityLevelOf(value: unknown): BrevityLevel {
	return BREVITY_LEVELS.includes(value as BrevityLevel) ? value as BrevityLevel : DEFAULT_BREVITY_LEVEL;
}

const LEVEL_RULES: Readonly<Record<Exclude<BrevityLevel, 'off'>, string>> = {
	lite: 'Level lite: no filler, no hedging, no pleasantries. Keep full sentences. Professional but tight.',
	full: 'Level full: drop filler, pleasantries and hedging; fragments are fine; short common words over long ones. No narration of tool calls, no decorative tables or emoji, no long raw logs unless asked — quote the shortest decisive line.',
	ultra: 'Level ultra: everything in full, and also drop conjunctions where cause and effect stay clear; one word where one word is enough; state each fact once.',
};

/** The system-prompt block for the level; null when the mode is off */
export function brevityBlock(level: BrevityLevel): string | null {
	if (level === 'off') {
		return null;
	}
	return `<brevity level="${level}">
Answer tersely. Every technical fact stays; only fluff goes.
${LEVEL_RULES[level]}
- Keep technical terms, code, file names, commands, API names and exact error strings verbatim. Keep numbers and units exact.
- Never drop «not», «never», «no», «only», «except» — a flipped meaning costs more than any saved word.
- Do not invent abbreviations and do not use arrows for cause: they save no tokens and cost the reader. If the terse form is not shorter than the plain one, write the plain one.
- One idea per sentence, active voice, the same word for the same thing. Clarity wins over terseness when they conflict.
- Keep the reply language the user writes in or the project sets; compress the style, not the language.
- Do not announce the mode and do not add a summary that repeats the answer.
- Write in full, normal prose: security warnings, confirmations of irreversible actions, multi-step instructions whose order a fragment could garble, and any answer when the user asks to clarify. Resume the terse style afterwards.
- Everything that leaves the chat is written in full, normal prose: code and its comments, commit messages, documentation, issue and PR texts, memory files, messages to other people.
</brevity>`;
}

/** The one-line form for local models, whose budgets cannot carry the full block */
export function brevityLine(level: BrevityLevel): string | null {
	if (level === 'off') {
		return null;
	}
	return `Brevity (${level}): answer tersely, keep every technical fact, code, names and errors verbatim; never drop negations; full prose for warnings, irreversible steps and anything that leaves the chat.`;
}
