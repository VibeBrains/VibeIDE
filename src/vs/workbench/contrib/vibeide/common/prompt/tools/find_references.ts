/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef, uriParam } from './_helpers.js';

export const FIND_REFERENCES_TOOL: ToolDef<'find_references'> = {
	name: 'find_references',
	description: `Finds all references to a symbol at a specific position in a file. Returns all locations where the symbol is used.`,
	params: {
		...uriParam('file'),
		line: { description: 'The line number (1-based) where the symbol is located.' },
		column: { description: 'The column number (1-based) where the symbol is located.' },
	},
};
