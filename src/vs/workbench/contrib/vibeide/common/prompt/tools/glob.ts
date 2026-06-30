/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { paginationParam, ToolDef } from './_helpers.js';

export const GLOB_TOOL: ToolDef<'glob'> = {
	name: 'glob',
	description: `Returns workspace files matching a glob pattern (e.g. "**/*.ts", "src/**/*test*", "packages/*/package.json"). ALWAYS use this for filename patterns. NEVER use run_command with find/where/dir /s — those duplicate this functionality and blow up stdout on large repos.`,
	params: {
		pattern: { description: 'Glob pattern. Examples: "**/*.ts", "src/**/components/*.tsx", "**/{Dockerfile,docker-compose.yml}".' },
		search_in_folder: { description: 'Optional. Restrict the search to descendants of this folder.' },
		...paginationParam,
	},
};
