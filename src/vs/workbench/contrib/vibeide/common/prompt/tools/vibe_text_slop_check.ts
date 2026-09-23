/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

/**
 * The name and the arguments are VibeIDEA's on purpose: the `anti-slop` skill and the `de-slop` pipeline of the
 * shared `.vibe` set call this tool by name, so one skill works in both products without an edit.
 */
export const VIBE_TEXT_SLOP_CHECK_TOOL: ToolDef<'vibe_text_slop_check'> = {
	name: 'vibe_text_slop_check',
	description: `Checks a text for the tells of machine writing. Deterministic: a fixed catalogue of rules, no model call, so two runs on an unchanged text give the same answer.

Finds stock words ("seamless", "unlock the potential", «бесшовный», «раскрыть потенциал»), empty phrases, templates like "it's not X — it's Y", the assistant's voice ("Great question!", "I hope this helps"), unattributed "studies show", monotonous rhythm and decorative formatting. Russian and English; code, quotes and links do not count as prose.

Call it AFTER writing a text for people — documentation, a README, release notes, a post, interface copy — and BEFORE handing it over. The answer names the line, the fragment found and how to fix it, plus a score by fixed arithmetic: a text passes from 90 and with no finding heavier than minor.

The score is a floor, not a verdict: an invented fact or a shifted meaning is invisible to it. The order of the rewrite and the check by a fresh reviewer are in the 'anti-slop' skill; the project's own rules are in '.vibe/slop.json'. The copy of a page in the preview is checked by design_review with the same catalogue.`,
	params: {
		// Both start with "Optional": the schema marks every other parameter required, and this tool takes one of
		// the two — the validator refuses a call that gives neither.
		path: { description: `Optional — give this or 'text'. The file to check, relative to the project root or absolute — for example docs/guide.md. When the file is open in an editor, its current text is checked, unsaved edits included. A file over 1 MB is refused: this is a check for prose — pass a long text in parts through 'text'.` },
		text: { description: `Optional — give this or 'path'. The text itself, when it is not in a file yet; when both are given, 'text' is checked.` },
	},
};
