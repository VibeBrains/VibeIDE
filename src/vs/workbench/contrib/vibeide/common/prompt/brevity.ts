/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * «Краткие ответы»: the agent answers tersely, keeping every technical fact.
 *
 * The text is not ours alone: it is `terse/replies.md` of the shared `.vibe` set, embedded in the build, and VibeIDEA
 * sends the model the same file. Its sections are the contract of both products:
 * - `## Level: lite|full|ultra` — only the chosen level goes;
 * - `## Off` — only to an agent that already has the style, when the mode is turned off;
 * - `## Short` — the form for a model with a tight prompt budget, sent instead of the common sections;
 * - every other section goes always, in file order.
 * The file's leading comment carries the MIT notice of the caveman skill it is based on, never the model's text.
 *
 * The block rides in the stable system prompt, not in each message: repeated per message it would cost
 * the very tokens the mode saves. A change of level changes the prompt, so it is part of the prompt's cache key.
 * Pure: a level and the file in, prompt text out.
 */

import { TERSE_REPLIES_MD } from './terseReplies.generated.js';

export type BrevityLevel = 'off' | 'lite' | 'full' | 'ultra';

export const BREVITY_LEVELS: readonly BrevityLevel[] = ['off', 'lite', 'full', 'ultra'];

/** On from the start: the terse style is the product's default, the full one is a choice */
export const DEFAULT_BREVITY_LEVEL: BrevityLevel = 'full';

export const BREVITY_SETTING = 'vibeide.chat.brevity';

/** The setting's value, or the default for anything else — a typo must not switch the mode off in silence */
export function brevityLevelOf(value: unknown): BrevityLevel {
	return BREVITY_LEVELS.includes(value as BrevityLevel) ? value as BrevityLevel : DEFAULT_BREVITY_LEVEL;
}

const OFF_SECTION = 'off';
const SHORT_SECTION = 'short';
const LEVEL_PREFIX = 'level:';

/** One `## ` section of the file: its heading, lowercased, and its whole text with the heading */
interface TerseSection {
	readonly heading: string;
	readonly text: string;
}

/** The sections after the leading comment; the comment is for the people editing the file, not for the model */
function terseSections(file: string): readonly TerseSection[] {
	const body = file.startsWith('<!--') ? file.slice(file.indexOf('-->') + '-->'.length) : file;
	return body.split(/^## /m).slice(1).map(part => ({
		heading: part.split('\n', 1)[0].trim().toLowerCase(),
		text: `## ${part.trim()}`,
	}));
}

function levelOf(heading: string): string | undefined {
	return heading.startsWith(LEVEL_PREFIX) ? heading.slice(LEVEL_PREFIX.length).trim() : undefined;
}

/**
 * The chosen level's section with the given base sections, in file order
 * Null when the file has no section for the level: half an instruction is worse than none
 */
function instruction(file: string, level: BrevityLevel, isBase: (heading: string) => boolean): string | null {
	if (level === 'off') {
		return null;
	}
	const sections = terseSections(file);
	if (!sections.some(section => levelOf(section.heading) === level)) {
		return null;
	}
	return sections
		.filter(section => {
			const sectionLevel = levelOf(section.heading);
			return sectionLevel !== undefined ? sectionLevel === level : isBase(section.heading);
		})
		.map(section => section.text)
		.join('\n\n');
}

/** The system-prompt block for the level: the common sections and the chosen level; null when the mode is off */
export function brevityBlock(level: BrevityLevel, file: string = TERSE_REPLIES_MD): string | null {
	return instruction(file, level, heading => heading !== OFF_SECTION && heading !== SHORT_SECTION);
}

/**
 * The short form for local models, whose budgets cannot carry the full block: the short section and the chosen level
 * A file without the short section gets the full block instead — the mode must not vanish with a missing section
 */
export function brevityShortBlock(level: BrevityLevel, file: string = TERSE_REPLIES_MD): string | null {
	if (!terseSections(file).some(section => section.heading === SHORT_SECTION)) {
		return brevityBlock(level, file);
	}
	return instruction(file, level, heading => heading === SHORT_SECTION);
}

/**
 * What an external agent has to be told, given the level it was last sent and the current one
 * The style goes once per session and again on a change of level; carried by every prompt it would pile up in the
 * agent's history. Off goes only to an agent that has the style: one that never got it has nothing to turn off.
 * Undefined — nothing to send
 */
export function brevityForAgent(sent: BrevityLevel | undefined, current: BrevityLevel, file: string = TERSE_REPLIES_MD): string | undefined {
	if (sent === current) {
		return undefined;
	}
	if (current === 'off') {
		return sent === undefined ? undefined : terseSections(file).find(section => section.heading === OFF_SECTION)?.text;
	}
	return brevityBlock(current, file) ?? undefined;
}
