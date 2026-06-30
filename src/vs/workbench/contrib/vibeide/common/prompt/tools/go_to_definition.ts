/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef, uriParam } from './_helpers.js';

export const GO_TO_DEFINITION_TOOL: ToolDef<'go_to_definition'> = {
	name: 'go_to_definition',
	description: `Finds the definition of a symbol at a specific position in a file. Returns the location(s) where the symbol is defined.`,
	params: {
		...uriParam('file'),
		line: { description: 'The line number (1-based) where the symbol is located.' },
		column: { description: 'The column number (1-based) where the symbol is located.' },
	},
};
