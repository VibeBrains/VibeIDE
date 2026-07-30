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

By default the findings are also drawn on the page itself — framed, labelled with the rule id, clickable. Each finding carries the element's CSS selector and the measured value, so a fix can be verified by running the tool again. Use it before claiming UI work is done, and after changing styles to show what moved.

Runs at two widths by default: a finding present at both is reported once, one that only appears at 390px carries 'viewport: mobile'. A layout defect that exists only on a phone is invisible to a single desktop pass.

Requires an open preview whose page carries the VibeIDE bridge — the same precondition as element inspect. The static runtime always injects it; a dev-server preview gets it through the bridge proxy (setting 'vibeide.vibeServer.bridgeProxy', on by default); a Docker preview has none. Without the bridge the tool says the page is out of reach instead of returning an empty result, because "nothing found" and "nothing measured" are different answers.`,
	params: {
		severity: { description: `Optional filter: 'error', 'warning' or 'info'. Omit to get everything, which is the usual case.` },
		annotate: { description: `true (default) frames every finding on the previewed page and labels it with its rule id, so the user can SEE what you are talking about and click a marker to ask about that one. Pass false only when the markers would get in the way (e.g. you are about to take a screenshot of the design itself).` },
		viewport: { description: `'both' (default), 'desktop' or 'mobile'. 'both' measures the page twice — the preview is really narrowed to 390px for the mobile pass, so media queries run — and reports width-specific findings with the width they appeared at.` },
	},
};
