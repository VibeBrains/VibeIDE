/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const EXTRACT_STRUCTURED_TOOL: ToolDef<'extract_structured'> = {
	name: 'extract_structured',
	description: `Extracts typed data from a web page by a JSON Schema, using a dedicated extraction model (setting vibeide.extract.model). Use it when you need specific fields from a page — prices, specs, lists, contacts — as JSON rather than readable text; use browse_url to read a page. The schema is the whole instruction: describe every field you want with its type, and add "description" to a field when its meaning is not obvious from the name.`,
	params: {
		url: { description: 'The full URL (including http:// or https://) of the page to extract from.' },
		schema: { description: 'A JSON Schema object for the result, e.g. {"type":"object","properties":{"price":{"type":"number"}},"required":["price"]}.' },
	},
};
