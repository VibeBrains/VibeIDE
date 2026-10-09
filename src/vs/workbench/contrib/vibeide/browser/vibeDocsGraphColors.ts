/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import {
	chartsBlue,
	chartsGreen,
	chartsOrange,
	chartsPurple,
	chartsRed,
	chartsYellow,
	registerColor,
	transparent,
	editorWarningForeground,
	editorErrorForeground,
} from '../../../../platform/theme/common/colorRegistry.js';
import { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { IGraphCanvasOptions } from './vibeGraphCanvas.js';

/**
 * Domain palette. The `charts.*` tokens are already theme-aware across light/dark/HC and users can
 * retheme them, so a docs domain borrows one instead of the graph inventing its own colour set.
 * Domains are folder names discovered at runtime, hence a fixed palette plus a stable hash rather
 * than a token per domain.
 */
export const DOC_GRAPH_DOMAIN_COLORS = [
	chartsBlue,
	chartsGreen,
	chartsPurple,
	chartsOrange,
	chartsYellow,
	chartsRed,
] as const;

/**
 * Stable colour per domain: the same folder keeps its colour across restarts and across machines,
 * which a registration-order index would not survive.
 */
export function domainColorId(domain: string): string {
	let hash = 0;
	for (let i = 0; i < domain.length; i++) {
		hash = (hash * 31 + domain.charCodeAt(i)) | 0;
	}
	return DOC_GRAPH_DOMAIN_COLORS[Math.abs(hash) % DOC_GRAPH_DOMAIN_COLORS.length];
}

/** A doc nobody can walk to from `README.md`. Obsidian has no concept of this; our gate does. */
export const VIBE_DOCS_GRAPH_UNREACHABLE = registerColor(
	'vibeide.docsGraph.unreachable',
	editorWarningForeground,
	localize('vibeide.docsGraph.unreachable', 'Цвет обводки документа, недостижимого от README.md, в графе документов.'),
);

/** A link whose target does not exist — drawn going nowhere. */
export const VIBE_DOCS_GRAPH_DEAD_LINK = registerColor(
	'vibeide.docsGraph.deadLink',
	editorErrorForeground,
	localize('vibeide.docsGraph.deadLink', 'Цвет битой ссылки в графе документов.'),
);

export const VIBE_DOCS_GRAPH_EDGE = registerColor(
	'vibeide.docsGraph.edge',
	transparent(chartsBlue, 0.35),
	localize('vibeide.docsGraph.edge', 'Цвет связей в графе документов.'),
);

/** How the docs graph paints on the shared canvas: a domain's colour, an unreachable doc ringed, dead links as stubs */
export const DOCS_GRAPH_CANVAS_STYLE: Pick<IGraphCanvasOptions, 'nodeColor' | 'colors'> = {
	nodeColor: (domain: string, theme: IColorTheme) => theme.getColor(domainColorId(domain))?.toString() ?? '#4080c0',
	colors: { edge: VIBE_DOCS_GRAPH_EDGE, flagged: VIBE_DOCS_GRAPH_UNREACHABLE, stub: VIBE_DOCS_GRAPH_DEAD_LINK },
};
