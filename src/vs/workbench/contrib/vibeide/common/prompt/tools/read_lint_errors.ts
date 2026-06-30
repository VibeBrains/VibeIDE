/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef, uriParam } from './_helpers.js';

export const READ_LINT_ERRORS_TOOL: ToolDef<'read_lint_errors'> = {
	name: 'read_lint_errors',
	description: `Use this tool to view all the lint errors on a file.`,
	params: {
		...uriParam('file'),
	},
};
