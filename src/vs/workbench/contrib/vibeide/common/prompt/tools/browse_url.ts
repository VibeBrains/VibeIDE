/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const BROWSE_URL_TOOL: ToolDef<'browse_url'> = {
	name: 'browse_url',
	description: `Fetches and extracts the main content from a web page. Returns readable text, title, and metadata. Use this after web_search to read the actual content of relevant pages.`,
	params: {
		url: { description: 'The full URL (including http:// or https://) to fetch and extract content from.' },
		refresh: { description: 'Optional. If true, bypasses cache and fetches fresh content. Default is false.' },
	},
};
