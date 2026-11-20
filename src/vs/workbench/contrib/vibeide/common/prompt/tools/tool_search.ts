/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TOOL_SEARCH_MAX_RESULTS_DEFAULT, TOOL_SEARCH_MAX_RESULTS_LIMIT } from '../toolDeferral.js';
import { ToolDef } from './_helpers.js';

/**
 * Доступ к инструментам, чьи схемы отложены
 *
 * Схемы всех MCP-серверов в каждом запросе весят сотни килобайт, а модель пользуется двумя-тремя
 * Поэтому сверх порога в запрос уходит только `tool_search`, а имена отложенных перечислены блоком
 * `<deferred_tools>`: без этого инструмента отложенный список был бы модели недостижим вовсе
 */
export const TOOL_SEARCH_TOOL: ToolDef<'tool_search'> = {
	name: 'tool_search',
	description: `Search the tools listed in <deferred_tools> and load them. Query "select:name1,name2" loads exact names; other text searches tool names and descriptions. Loaded tools become callable from the next step.`,
	params: {
		query: {
			description: `"select:name1,name2" to load exact tool names, or keywords to search tool names and descriptions.`,
		},
		max_results: {
			description: `Optional. How many matches to return. Default ${TOOL_SEARCH_MAX_RESULTS_DEFAULT}, at most ${TOOL_SEARCH_MAX_RESULTS_LIMIT}.`,
		},
	},
};
