/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ToolDef, uriParam } from './_helpers.js';

export const GENERATE_TESTS_TOOL: ToolDef<'generate_tests'> = {
	name: 'generate_tests',
	// Writes a new test file into the workspace → gate like edit_file: excluded from read-only
	// Gather/Plan modes, approval-prompted in Agent mode.
	approvalType: 'edits',
	description: `Generates unit or integration tests for code in a file. Can generate tests for a specific function or the entire file.`,
	params: {
		...uriParam('file'),
		function_name: { description: 'Optional. The name of the function to generate tests for. If not provided, generates tests for the entire file.' },
		test_framework: { description: 'Optional. The test framework to use (e.g., "jest", "mocha", "pytest"). Defaults to the framework detected from the project.' },
	},
};
