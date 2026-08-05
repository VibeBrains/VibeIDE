/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const DOCS_SEARCH_TOOL: ToolDef<'docs_search'> = {
	name: 'docs_search',
	description: `Searches VibeIDE's OWN documentation — the manuals and the feature catalogue shipped inside this build. Lexical and deterministic: no model call, no network, works offline, and describes the version actually installed rather than whatever the repository's main branch looks like today.

Use it BEFORE guessing about anything VibeIDE-specific:
- a config file the user asks you to create ('.vibe/servers.json', '.vibe/providers.json') — the format specs live here, with field tables and worked examples;
- how a feature is meant to be driven (design detector, Vibe Server stack, specs workflow, skills) — including preconditions that are easy to miss, like "the design detector needs an open preview";
- what the product can do at all, when the user's request is vague.

Answers cite file, heading and line, so the user can check the claim. Returns the matching sections, not whole documents — read a file in full only when a section is not enough.

An empty result is reported as such, with the number of files searched: "not documented here" and "the tool failed" are different answers, and neither means "go and invent it". If nothing is found, ask the user rather than guessing.

Note: internal engineering notes (docs/knowledge — build gotchas, incident post-mortems) are NOT indexed. This is user-facing documentation only.`,
	params: {
		query: { description: `What to look for, in the user's own words. Russian or English both work; the corpus is mostly Russian. Prefer concrete terms ('servers.json', 'дизайн детектор', 'провайдеры') over full sentences.` },
		limit: { description: `Optional cap on returned sections (default 5). Raise it when surveying a broad topic, lower it when you need only the definitive section.` },
	},
};
