/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { paginationParam, ToolDef } from './_helpers.js';

export const SEARCH_PATHNAMES_ONLY_TOOL: ToolDef<'search_pathnames_only'> = {
	name: 'search_pathnames_only',
	description: `Fuzzy search over file PATHNAMES (not contents). Use this when you remember a partial name. For exact glob patterns (e.g. "**/*.ts"), use the glob tool instead. NEVER use run_command with find/where/dir /s — those duplicate this functionality.`,
	params: {
		query: { description: `Your query for the search.` },
		include_pattern: { description: 'Optional. Only fill this in if you need to limit your search because there were too many results.' },
		...paginationParam,
	},
};
