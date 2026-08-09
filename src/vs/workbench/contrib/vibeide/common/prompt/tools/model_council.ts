/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const MODEL_COUNCIL_TOOL: ToolDef<'model_council'> = {
	name: 'model_council',
	description: `Asks several DIFFERENT models the same question independently, then has one model fold their answers into agreements, disagreements, and what would settle the argument. Read-only: it changes nothing in the project.

Use it for a decision where being wrong is expensive and one opinion is not enough: choosing an approach or a library, judging whether a design will hold, reviewing a risky migration plan. Do NOT use it for questions with a checkable answer — read the file, run the command, or grep instead; a council cannot make a fact out of a guess.

Costs one request per adviser plus one for the summary, so ask a question worth that. Advisers are configured by the user (\`vibeide.council.advisers\`); when none are set, the tool says so instead of quietly answering alone.`,
	params: {
		question: { description: 'The decision to put to the council, stated as a choice ("A or B, and why"), not as an open topic.' },
		context: { description: 'Optional material every adviser gets verbatim: constraints, the relevant code, what was already tried.' },
	},
};
