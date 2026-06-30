/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { paginationParam, ToolDef, uriParam } from './_helpers.js';

export const READ_FILE_TOOL: ToolDef<'read_file'> = {
	name: 'read_file',
	description: `ALWAYS use this tool to read file contents. NEVER use run_command with cat/Get-Content/type/head/tail — those stream through stdout and can hang the IDE on large files. Returns the file contents with line numbers (1-based, prefix "<line>\\t<content>"), so the result is directly usable for subsequent edit_file calls. Defaults to the first 2000 lines; raise line_limit only when necessary. Paginated via page_number for very large files. PDF / Jupyter / image files are routed automatically.`,
	params: {
		...uriParam('file'),
		start_line: { description: 'Optional. 1-based. Start reading from this line. Defaults to the beginning of the file.' },
		end_line: { description: 'Optional. 1-based, inclusive. Stop reading at this line. Defaults to start_line + line_limit (or end of file).' },
		line_limit: { description: `Optional. Maximum number of lines to return. Default ${2000}, max ${10_000}. Use a tighter value when scanning, a larger one when you need full context.` },
		with_line_numbers: { description: 'Optional. Default true. When true, each returned line is prefixed with "<line_num>\\t". Set to false only when feeding into systems that do not expect numbers.' },
		...paginationParam,
	},
};
