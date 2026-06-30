/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { paginationParam, ToolDef } from './_helpers.js';

export const SEARCH_FOR_FILES_TOOL: ToolDef<'search_for_files'> = {
	name: 'search_for_files',
	description: `Returns file names whose content matches a query. For richer content search (with line numbers, glob/type filters, multiline, head_limit), prefer the grep tool. NEVER use run_command with grep/rg/findstr/Select-String — those duplicate this functionality.`,
	params: {
		query: { description: `Your query for the search.` },
		search_in_folder: { description: 'Optional. Leave as blank by default. ONLY fill this in if your previous search with the same query was truncated. Searches descendants of this folder only.' },
		is_regex: { description: 'Optional. Default is false. Whether the query is a regex.' },
		...paginationParam,
	},
};
