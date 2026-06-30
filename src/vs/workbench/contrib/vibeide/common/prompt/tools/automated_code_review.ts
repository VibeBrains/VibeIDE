/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef, uriParam } from './_helpers.js';

export const AUTOMATED_CODE_REVIEW_TOOL: ToolDef<'automated_code_review'> = {
	name: 'automated_code_review',
	description: `Analyzes code in a file for potential issues, bugs, code smells, and suggests improvements. Returns a list of issues with severity and suggestions.`,
	params: {
		...uriParam('file'),
	},
};
