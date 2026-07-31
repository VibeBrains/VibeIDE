/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const DESIGN_DOCUMENT_TOOL: ToolDef<'design_document'> = {
	name: 'design_document',
	description: `Writes the project's design context — the counterpart to design_context, which reads it.

Two targets:
- 'product' — writes 'product.md' from what the USER told you. Ask them first, in their language, and keep the answers concrete: "solo founders evaluating a tool on their phone between meetings", not "users". Two questions are usually enough: who is it for, and what does it make possible that a neighbour could not truthfully claim. Decide the platform from the code and only ask when the evidence is ambiguous. Do NOT ask about colours or typefaces here — those get decided together with the surface they belong to.
- 'system' — measures the page open in the preview and writes 'design.md' from what the page ACTUALLY computed: families, palette, type scale, radii, shadows. Stylesheets say what was written; the snapshot says what won.

With apply=false (the default for 'system') the draft comes back for review instead of being written — the polite first step when the file already exists. Named rules and accepted drift already in the file are preserved: a measurement is not a decision, and the file says so.

Requires an open preview for 'system' (same precondition as design_review). Without one it reports that nothing was measured rather than writing an empty system.`,
	params: {
		target: { description: `'product' or 'system'.` },
		name: { description: `Optional heading name. Defaults to the workspace folder name.` },
		audience: { description: `Target 'product': who it is for, concretely — a role in a situation.` },
		positioning: { description: `Target 'product': what it makes possible, and what a neighbour could not truthfully claim.` },
		platform: { description: `Target 'product': 'web', 'ios', 'android' or 'adaptive'.` },
		notes: { description: `Target 'product': anything else worth pinning that has no section of its own.` },
		apply: { description: `true writes the file; false returns the draft. Defaults to true for 'product' (the user just dictated it) and false for 'system'.` },
	},
	approvalType: 'edits',
};
