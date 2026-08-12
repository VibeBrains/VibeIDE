/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const HANDOFF_TOOL: ToolDef<'handoff'> = {
	name: 'handoff',
	description: `Writes or reads a handoff — the formal transfer of work between agents, threads and machines.

Use 'write' when work stops without finishing: the context window is filling up, the task moves to another machine, a role hands back to the orchestrator, or the user is about to close the session. Use 'read' at the start of work on something someone else already touched.

Why a form instead of prose: a spoken handover fails the same way every time. The next agent learns WHAT was done and does not learn where the work got stuck or what counts as the next step — and those two are exactly what cannot be recovered by reading the code.

- 'done' — what is actually finished, not what was attempted.
- 'blockers' — where it got stuck, and what you already ruled out. Write "none" only if you genuinely hit none.
- 'next' — a concrete action, not a direction. "Run the smoke on a live key" is a step; "improve reliability" is not.
- 'environment' — branch, uncommitted work, running processes: the state the next agent will not see from the code.

An empty section is written out as "not stated" rather than dropped: "no blockers" and "nobody said" are different messages, and the next agent has to be able to tell them apart.

Handoffs live in '.vibe/handoffs/' as plain markdown — readable without this IDE, versioned by git next to the code, and portable to another machine.`,
	params: {
		action: { description: `'write' to record a handoff, 'read' to load the most recent one.` },
		title: { description: `One line naming the work. Required for 'write'.` },
		done: { description: `Array of strings: what is finished.` },
		blockers: { description: `Array of strings: where it got stuck and what was ruled out.` },
		next: { description: `Array of strings: the concrete next actions.` },
		environment: { description: `Free text: branch, uncommitted changes, running processes.` },
	},
};
