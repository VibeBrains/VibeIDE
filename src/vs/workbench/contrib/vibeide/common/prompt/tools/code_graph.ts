/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const CODE_GRAPH_TOOL: ToolDef<'code_graph'> = {
	name: 'code_graph',
	description: `Walks the project's structural graph instead of guessing with grep. Answers three questions:
- 'neighbors': what touches this file or symbol — what it imports, what imports it, what it declares, which notes explain it.
- 'path': how two files or symbols are connected, as the shortest chain between them.
- 'why': why a given file is part of the picture — its importers, its imports, its symbols and its explanatory notes.

Every edge is labelled with how it was established: 'extracted' was read from the source, 'inferred' was completed by a resolver (for example an import path that needed an extension), 'ambiguous' had several equally plausible targets. Treat 'extracted' as fact and the other two as leads worth confirming.

Prefer this over repeated greps when the question is about relationships rather than text. If the index has not warmed yet, the tool says so — an empty answer then means "not indexed", not "not connected".`,
	params: {
		query: { description: `One of 'neighbors', 'path', or 'why'.` },
		target: { description: `The starting node: an absolute file path ('/repo/src/app.ts') or a symbol inside one ('/repo/src/app.ts#doWork').` },
		to: { description: `Only for 'path': the destination node, in the same form as 'target'. Omit for the other queries.` },
	},
};
