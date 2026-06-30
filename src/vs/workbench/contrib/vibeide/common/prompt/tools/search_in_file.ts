/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef, uriParam } from './_helpers.js';

export const SEARCH_IN_FILE_TOOL: ToolDef<'search_in_file'> = {
	name: 'search_in_file',
	description: `Returns an array of all the start line numbers where the content appears in the file.`,
	params: {
		...uriParam('file'),
		query: { description: 'The string or regex to search for in the file.' },
		is_regex: { description: 'Optional. Default is false. Whether the query is a regex.' },
	},
};
