/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDef } from './_helpers.js';

/**
 * Обратная сторона сжатия вывода: развернуть то, что свернули.
 *
 * Читает из памяти окна, ничего не выполняет — поэтому без гейта подтверждения, в отличие от
 * повторного запуска команды, который до сих пор был единственным способом достать подробность.
 */
export const EXPAND_OUTPUT_TOOL: ToolDef<'expand_output'> = {
	name: 'expand_output',
	description: `Bring back the full output of a command that was compressed before you read it. Read-only, and free of the command's side effects — unlike re-running it, which is what you would otherwise have to do.

Compressed output ends with a marker like [vibe#o3: 230 строк свёрнуто; полный вывод — expand_output ref="o3"]. Pass that ref here.

Use 'query' to pull only the lines you need: expand_output(ref='o3', query='FAILED') beats reading the whole log back into context. Reach for this when the compressed rendering left you guessing — a stack trace cut short, a warning you only saw the count of — instead of re-running a build or a test suite to see it again.

The archive holds the most recent outputs of this window only. An unknown ref means it aged out, not that the command produced nothing.`,
	params: {
		ref: {
			description: `The reference from the output marker, e.g. 'o3'. Pasting the whole '[vibe#o3: …]' marker also works.`,
		},
		query: {
			description: `Optional substring filter, case-insensitive: only lines containing it come back. Omit for the whole output.`,
		},
	},
};
