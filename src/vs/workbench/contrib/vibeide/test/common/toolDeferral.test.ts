/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { availableTools, builtinTools, InternalToolInfo } from '../../common/prompt/prompts.js';
import { CORE_TOOL_NAMES, sacrificeOrder } from '../../common/prompt/toolBudget.js';
import {
	DEFAULT_TOOL_SEARCH_THRESHOLD_CHARS,
	deferredToolsPromptBlock,
	loadedToolNamesOf,
	partitionToolsForDeferral,
	searchTools,
	TOOL_SEARCH_TOOL_NAME,
	toolSchemaChars,
	toolSchemasChars,
	toolSchemasTokens,
} from '../../common/prompt/toolDeferral.js';

const BUILTINS = new Set(['read_file', 'web_search']);

function tool(name: string, description = name, mcpServerName?: string): InternalToolInfo {
	return mcpServerName === undefined
		? { name, description, params: {} }
		: { name, description, params: {}, mcpServerName };
}

function names(tools: readonly InternalToolInfo[]): string[] {
	return tools.map(t => t.name);
}

function totalChars(tools: readonly InternalToolInfo[]): number {
	return tools.reduce((sum, t) => sum + toolSchemaChars(t), 0);
}

const TOOL_SEARCH: InternalToolInfo = tool(TOOL_SEARCH_TOOL_NAME, 'Find tools by name or description.');

suite('toolDeferral', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('off: все схемы уходят целиком, tool_search не появляется', () => {
		const tools = [tool('read_file'), tool('web_search'), tool('mcp_one', 'one', 'srv')];
		const result = partitionToolsForDeferral(tools, BUILTINS, TOOL_SEARCH, {
			mode: 'off',
			thresholdChars: 0,
			loadedToolNames: new Set(),
		});
		assert.deepStrictEqual(
			{ offered: names(result.offered), deferred: names(result.deferred) },
			{ offered: ['read_file', 'web_search', 'mcp_one'], deferred: [] },
		);
	});

	test('auto ниже порога: ничего не откладывается и tool_search не появляется', () => {
		const tools = [tool('read_file'), tool('web_search'), tool('mcp_one', 'm'.repeat(120), 'srv')];
		const result = partitionToolsForDeferral(tools, BUILTINS, TOOL_SEARCH, {
			mode: 'auto',
			thresholdChars: totalChars(tools),
			loadedToolNames: new Set(),
		});
		assert.deepStrictEqual(
			{ offered: names(result.offered), deferred: names(result.deferred) },
			{ offered: ['read_file', 'web_search', 'mcp_one'], deferred: [] },
		);
	});

	test('auto выше порога: MCP уходят раньше встроенных и откладывание останавливается, как только влезло', () => {
		const tools = [tool('read_file'), tool('web_search'), tool('mcp_one', 'm'.repeat(120), 'srv'), tool('mcp_two', 'two', 'srv')];
		// Порог ровно настолько ниже суммы, чтобы хватило отложить один mcp_one: его схему заменяет tool_search
		const thresholdChars = totalChars(tools) - toolSchemaChars(tools[2]) + toolSchemaChars(TOOL_SEARCH);
		const result = partitionToolsForDeferral(tools, BUILTINS, TOOL_SEARCH, {
			mode: 'auto',
			thresholdChars,
			loadedToolNames: new Set(),
		});
		assert.deepStrictEqual(
			{ offered: names(result.offered), deferred: names(result.deferred) },
			{ offered: ['read_file', 'web_search', 'mcp_two', TOOL_SEARCH_TOOL_NAME], deferred: ['mcp_one'] },
		);
	});

	test('ядро не откладывается никогда, даже когда в порог не влезает и оно', () => {
		const tools = [tool('read_file'), tool('edit_file'), tool('mcp_one', 'x', 'srv')];
		const result = partitionToolsForDeferral(tools, BUILTINS, TOOL_SEARCH, {
			mode: 'auto',
			thresholdChars: 0,
			loadedToolNames: new Set(),
		});
		assert.deepStrictEqual(
			{ offered: names(result.offered), deferred: names(result.deferred) },
			{ offered: ['read_file', 'edit_file', TOOL_SEARCH_TOOL_NAME], deferred: ['mcp_one'] },
		);
	});

	test('уже загруженные инструменты не откладываются', () => {
		const tools = [tool('read_file'), tool('mcp_one', 'x', 'srv'), tool('mcp_two', 'y', 'srv')];
		const result = partitionToolsForDeferral(tools, BUILTINS, TOOL_SEARCH, {
			mode: 'always',
			thresholdChars: 0,
			loadedToolNames: new Set(['mcp_two']),
		});
		assert.deepStrictEqual(
			{ offered: names(result.offered), deferred: names(result.deferred) },
			{ offered: ['read_file', 'mcp_two', TOOL_SEARCH_TOOL_NAME], deferred: ['mcp_one'] },
		);
	});

	test('always: в deferred уходит всё, кроме ядра и загруженного, в порядке жертв', () => {
		const tools = [tool('read_file'), tool('web_search'), tool('mcp_one', 'x', 'srv'), tool('edit_file')];
		const result = partitionToolsForDeferral(tools, BUILTINS, TOOL_SEARCH, {
			mode: 'always',
			thresholdChars: DEFAULT_TOOL_SEARCH_THRESHOLD_CHARS,
			loadedToolNames: new Set(),
		});
		assert.deepStrictEqual(
			{ offered: names(result.offered), deferred: names(result.deferred) },
			{ offered: ['read_file', 'edit_file', TOOL_SEARCH_TOOL_NAME], deferred: ['mcp_one', 'web_search'] },
		);
	});

	test('tool_search добавляется последним только при непустом deferred', () => {
		const tools = [tool('read_file'), tool('edit_file')];
		const result = partitionToolsForDeferral(tools, BUILTINS, TOOL_SEARCH, {
			mode: 'always',
			thresholdChars: 0,
			loadedToolNames: new Set(),
		});
		assert.deepStrictEqual(
			{ offered: names(result.offered), deferred: names(result.deferred) },
			{ offered: ['read_file', 'edit_file'], deferred: [] },
		);
	});

	test('deferredToolsPromptBlock группирует встроенные и MCP по серверам в порядке появления', () => {
		const deferred = [
			tool('mcp_a1', 'x', 'alpha'),
			tool('web_search'),
			tool('mcp_b1', 'y', 'beta'),
			tool('mcp_a2', 'z', 'alpha'),
		];
		assert.deepStrictEqual(deferredToolsPromptBlock(deferred), [
			'<deferred_tools>',
			'These tools exist but their schemas are not loaded. To use one, call tool_search first: query "select:name1,name2" loads exact names, other text searches names and descriptions. Loaded tools become callable from the next step.',
			'Built-in: web_search',
			'MCP server alpha: mcp_a1, mcp_a2',
			'MCP server beta: mcp_b1',
			'</deferred_tools>',
		].join('\n'));
	});

	test('deferredToolsPromptBlock пуст для пустого списка', () => {
		assert.deepStrictEqual(deferredToolsPromptBlock([]), '');
	});

	test('searchTools: select берёт точные имена в порядке запроса, пропускает неизвестные и не режет maxResults', () => {
		const candidates = [tool('alpha'), tool('beta'), tool('gamma')];
		assert.deepStrictEqual(
			searchTools('Select: gamma , nope, alpha', candidates, 1).map(m => m.name),
			['gamma', 'alpha'],
		);
	});

	test('searchTools: слово из имени весомее слова из описания', () => {
		const inName = tool('alpha_search', 'nothing relevant here');
		const inDescription = tool('beta', 'can find alpha things');
		assert.deepStrictEqual(
			searchTools('alpha', [inDescription, inName], 5).map(m => m.name),
			['alpha_search', 'beta'],
		);
	});

	test('searchTools: при равных очках сохраняется порядок кандидатов, нулевые совпадения не возвращаются', () => {
		const candidates = [tool('one', 'search alpha'), tool('two', 'alpha search'), tool('three', 'nothing')];
		assert.deepStrictEqual(searchTools('alpha', candidates, 5).map(m => m.name), ['one', 'two']);
	});

	test('searchTools: maxResults ограничивает выдачу', () => {
		const candidates = [tool('alpha_one', 'alpha'), tool('alpha_two', 'alpha'), tool('alpha_three', 'alpha')];
		assert.deepStrictEqual(searchTools('alpha', candidates, 2).map(m => m.name), ['alpha_one', 'alpha_two']);
	});

	test('searchTools: описание в выдаче — первая фраза, не длиннее 200 символов', () => {
		const candidates = [
			tool('one', 'First sentence. Second sentence'),
			tool('two', 'Line one\nline two'),
			tool('three', `${'x'.repeat(250)}. Next sentence`),
		];
		assert.deepStrictEqual(
			searchTools('select: one, two, three', candidates, 5).map(m => m.description),
			['First sentence', 'Line one', 'x'.repeat(200)],
		);
	});

	test('toolSchemasChars: сумма схем списка, ноль у пустого и отсутствующего', () => {
		const tools = [tool('alpha', 'x'.repeat(100)), tool('beta')];
		assert.deepStrictEqual(
			[toolSchemasChars(tools), toolSchemasChars([]), toolSchemasChars(undefined)],
			[totalChars(tools), 0, 0],
		);
	});

	test('toolSchemasTokens: символы делятся на четыре с округлением вверх, как текст промпта', () => {
		const tools = [tool('alpha', 'x'.repeat(100)), tool('beta')];
		assert.deepStrictEqual(
			[toolSchemasTokens(tools), toolSchemasTokens([])],
			[Math.ceil(totalChars(tools) / 4), 0],
		);
	});

	test('loadedToolNamesOf объединяет вызванные инструменты и то, что загрузил tool_search', () => {
		const loaded = loadedToolNamesOf([
			{ name: 'read_file' },
			{ name: TOOL_SEARCH_TOOL_NAME, loadedNames: ['mcp_one', 'mcp_two'] },
		]);
		assert.deepStrictEqual([...loaded].sort(), ['mcp_one', 'mcp_two', 'read_file', TOOL_SEARCH_TOOL_NAME].sort());
	});

	test('sacrificeOrder не включает ядро и ставит MCP впереди встроенных', () => {
		const mcp = tool('jira_create_issue', 'issue', 'jira');
		const tools = [...(availableTools('agent', undefined) ?? []), mcp];
		const order = names(sacrificeOrder(tools, new Set(Object.keys(builtinTools))));
		assert.deepStrictEqual(
			{
				coreInside: CORE_TOOL_NAMES.some(n => order.includes(n)),
				first: order[0],
				total: order.length === tools.length - CORE_TOOL_NAMES.length,
			},
			{ coreInside: false, first: 'jira_create_issue', total: true },
		);
	});
});
