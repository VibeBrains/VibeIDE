/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyToolBudget, CORE_TOOL_NAMES } from '../../common/prompt/toolBudget.js';
import { availableTools, builtinTools, InternalToolInfo } from '../../common/prompt/prompts.js';

function tool(name: string): InternalToolInfo {
	return { name, description: name, params: {} };
}

const BUILTINS = new Set(Object.keys(builtinTools));

suite('tool budget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('no budget, zero or a budget larger than the list all pass through untouched', () => {
		const tools = [tool('read_file'), tool('edit_file'), tool('web_search')];
		assert.deepStrictEqual(
			[undefined, 0, -5, NaN, 99].map(b => applyToolBudget(tools, b as number, BUILTINS).tools.length),
			[3, 3, 3, 3, 3],
		);
	});

	test('MCP tools are sacrificed before built-ins', () => {
		const tools = [tool('read_file'), tool('edit_file'), tool('web_search'), tool('jira_create_issue')];
		const result = applyToolBudget(tools, 3, BUILTINS);
		assert.deepStrictEqual(
			{ kept: result.tools.map(t => t.name), dropped: [...result.dropped] },
			{ kept: ['read_file', 'edit_file', 'web_search'], dropped: ['jira_create_issue'] },
		);
	});

	test('the core survives a budget that would otherwise cut it', () => {
		// One tool of budget, eight core tools present: the core wins and says so out loud.
		// A budget that removes edit_file does not make a lighter agent, it makes a lying one.
		const tools = CORE_TOOL_NAMES.map(tool).concat([tool('web_search')]);
		const result = applyToolBudget(tools, 1, BUILTINS);
		assert.deepStrictEqual(
			{
				kept: result.tools.map(t => t.name),
				dropped: [...result.dropped],
				coreExceedsBudget: result.coreExceedsBudget,
			},
			{ kept: [...CORE_TOOL_NAMES], dropped: ['web_search'], coreExceedsBudget: true },
		);
	});

	test('the same budget yields the same list every time — a bug report must reproduce', () => {
		const tools = [...Object.keys(builtinTools).map(tool), tool('mcp_one'), tool('mcp_two')];
		const runs = [0, 1, 2].map(() => applyToolBudget(tools, 12, BUILTINS).tools.map(t => t.name).join(','));
		assert.strictEqual(new Set(runs).size, 1);
	});

	test('availableTools applies the budget and always keeps the core', () => {
		const full = availableTools('agent', undefined) ?? [];
		const trimmed = availableTools('agent', undefined, { maxTools: 12 }) ?? [];
		const names = new Set(trimmed.map(t => t.name));
		assert.deepStrictEqual(
			{
				shrank: trimmed.length < full.length,
				withinBudget: trimmed.length <= 12,
				coreKept: CORE_TOOL_NAMES.every(n => names.has(n)),
				untouchedWithoutBudget: (availableTools('agent', undefined) ?? []).length === full.length,
			},
			{ shrank: true, withinBudget: true, coreKept: true, untouchedWithoutBudget: true },
		);
	});
});
