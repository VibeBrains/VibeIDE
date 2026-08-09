/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Outline glyphs for VibeIDE's own Command Center buttons.
 *
 * Why SVG and not a font: codicons have neither a command symbol nor a brain, the Font Awesome
 * faces we ship are filled (heavier than every neighbour), and a text character like ⌘ follows the
 * text metrics of whatever system font resolves it — a different size, weight and baseline than
 * the icons beside it, on every platform. Drawing both glyphs here puts them on one grid, one
 * stroke width and one colour token, so they sit in the row as if they came from the same set.
 */

import { mainWindow } from '../../../../base/browser/window.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Matches the codicon line weight at 16px; anything thinner reads as a different icon set. */
const STROKE_WIDTH = '1.15';

/** ⌘ (place of interest): a centre square whose four sides each run into a corner loop. */
const COMMAND_PATHS: readonly string[] = [
	'M6.4 6.4h3.2v3.2H6.4z',
	'M6.4 6.4H4.9a1.5 1.5 0 1 1 1.5-1.5v1.5',
	'M9.6 6.4h1.5a1.5 1.5 0 1 0-1.5-1.5v1.5',
	'M6.4 9.6H4.9a1.5 1.5 0 1 0 1.5 1.5V9.6',
	'M9.6 9.6h1.5a1.5 1.5 0 1 1-1.5 1.5V9.6',
];

/** Brain: two hemispheres plus the folds that keep it readable at 16px. */
const BRAIN_PATHS: readonly string[] = [
	'M6.4 2.3c-1 0-1.8.7-1.9 1.6-.9.1-1.6.9-1.6 1.8 0 .4.1.7.3 1-.5.4-.8 1-.8 1.6 0 .8.5 1.5 1.2 1.8 0 .1 0 .2 0 .3 0 1.1.9 2 2 2 .5 0 1-.2 1.4-.5v-8c0-.9-.7-1.6-1.6-1.6z',
	'M9.6 2.3c1 0 1.8.7 1.9 1.6.9.1 1.6.9 1.6 1.8 0 .4-.1.7-.3 1 .5.4.8 1 .8 1.6 0 .8-.5 1.5-1.2 1.8 0 .1 0 .2 0 .3 0 1.1-.9 2-2 2-.5 0-1-.2-1.4-.5v-8c0-.9.7-1.6 1.6-1.6z',
	'M6 5.6c-.7 0-1.2.5-1.2 1.1M6.2 9.2c-.8 0-1.4-.5-1.4-1.2M10 5.6c.7 0 1.2.5 1.2 1.1M9.8 9.2c.8 0 1.4-.5 1.4-1.2',
];

/**
 * Build an outline glyph node-by-node. Not `innerHTML`: Trusted Types rejects raw HTML assignment
 * in the workbench. `stroke: currentColor` is what lets the CSS colour token drive both themes.
 */
function createOutlineGlyph(paths: readonly string[]): SVGSVGElement {
	const svg = mainWindow.document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', STROKE_WIDTH);
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	for (const d of paths) {
		const path = mainWindow.document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
	}
	return svg;
}

export function createCommandGlyph(): SVGSVGElement {
	return createOutlineGlyph(COMMAND_PATHS);
}

export function createBrainGlyph(): SVGSVGElement {
	return createOutlineGlyph(BRAIN_PATHS);
}
