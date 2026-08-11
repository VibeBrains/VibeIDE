/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const DESIGN_CONTEXT_TOOL: ToolDef<'design_context'> = {
	name: 'design_context',
	description: `Reads the project's design context — the files every design decision leans on. Read-only.

'product.md' carries strategy: who this is for, concretely, and what the product makes possible that a neighbouring product could not truthfully claim. 'design.md' carries the visual world: palette, typefaces, type scale, shape, NAMED RULES, and the detector findings this project has declared to be its identity rather than defects.

WHY THIS MATTERS: a screen generated without this context comes out generic — this is the single biggest difference between "an AI made this" and "this belongs to that product". Call this BEFORE generating or restyling any UI, and quote the named rules by name when you defend a decision ("The Semantic-Reuse Rule says warning is the brand yellow").

'components.md' carries per-component reminders in the project's own words — what a form, a field, a modal, a table, an empty state or a loading state must not forget. These are for BUILD TIME, not review time: the detector measures a finished page and cannot see a submitting state, an empty-because-filtered list, or focus returning after a modal closes. When you are about to build a component of one of those kinds, read its note FIRST and follow it.

Returns the files parsed (families, palette, named rules, accepted drift, platform) and verbatim, plus where they were read from. When nothing is written yet it says so — then offer to collect it with design_document, do not invent a design system silently.`,
	params: {},
};
