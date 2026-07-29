/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const DESIGN_REVIEW_TOOL: ToolDef<'design_review'> = {
	name: 'design_review',
	description: `Measures the page currently open in the Vibe Server preview and reports design defects. Deterministic: the checks read what the page actually computed (font sizes, contrast, spacing, animations) and run without a model, so two runs on an unchanged page give the same answer.

Reports three kinds of finding:
- 'error': broken for the reader — for example text below the WCAG AA contrast floor.
- 'warning': hurts readability or reach — text under 12px, cramped tap targets, lines over ~95 characters, tight leading.
- 'info': tells that the interface was assembled by inertia rather than designed — gradient text, the default violet ramp, a radial halo behind the hero, coloured glow used as a shadow, marketing filler in the copy.

Each finding carries the element's CSS selector and the measured value, so a fix can be verified by running the tool again. Use it before claiming UI work is done, and after changing styles to show what moved.

Requires an open preview from the static runtime — the same precondition as element inspect. With a dev-server or Docker preview the tool says the page is out of reach instead of returning an empty result, because "nothing found" and "nothing measured" are different answers.`,
	params: {
		severity: { description: `Optional filter: 'error', 'warning' or 'info'. Omit to get everything, which is the usual case.` },
	},
};
