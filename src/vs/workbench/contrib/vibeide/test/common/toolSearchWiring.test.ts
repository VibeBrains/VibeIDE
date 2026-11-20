/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { availableTools, availableToolsWithDeferral, chat_systemMessage, InternalToolInfo } from '../../common/prompt/prompts.js';
import { CORE_TOOL_NAMES } from '../../common/prompt/toolBudget.js';
import { DEFAULT_TOOL_SEARCH_THRESHOLD_CHARS, TOOL_SEARCH_TOOL_NAME } from '../../common/prompt/toolDeferral.js';

/** MCP-инструмент с параметром: схема должна быть видна по тексту описания */
function mcpTool(name: string, serverName = 'srv'): InternalToolInfo {
	return {
		name,
		description: `${name} does things on the server`,
		params: { query: { description: 'what to look for' } },
		mcpServerName: serverName,
	};
}

const ALWAYS = { mode: 'always' as const, thresholdChars: DEFAULT_TOOL_SEARCH_THRESHOLD_CHARS, loadedToolNames: [] as const };

suite('toolSearchWiring', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('без toolSearch список прежний: tool_search не появляется, MCP на месте', () => {
		const mcp = mcpTool('jira_create_issue');
		const plain = availableTools('agent', [mcp]) ?? [];
		assert.deepStrictEqual({
			hasToolSearch: plain.some(t => t.name === TOOL_SEARCH_TOOL_NAME),
			hasMcp: plain.some(t => t.name === mcp.name),
			sameLengthAsEmptyOpts: plain.length === (availableTools('agent', [mcp], {}) ?? []).length,
		}, { hasToolSearch: false, hasMcp: true, sameLengthAsEmptyOpts: true });
	});

	test('always: схемой остаются ядро и tool_search, остальное уходит в deferred', () => {
		const mcp = mcpTool('jira_create_issue');
		const { offered, deferred } = availableToolsWithDeferral('agent', [mcp], { toolSearch: ALWAYS });
		assert.deepStrictEqual({
			offered: (offered ?? []).map(t => t.name).sort(),
			deferredHasMcp: deferred.some(t => t.name === mcp.name),
		}, {
			offered: [...CORE_TOOL_NAMES, TOOL_SEARCH_TOOL_NAME].sort(),
			deferredHasMcp: true,
		});
	});

	test('загруженное имя остаётся в offered, а не откладывается', () => {
		const mcp = mcpTool('jira_create_issue');
		const { offered, deferred } = availableToolsWithDeferral('agent', [mcp], {
			toolSearch: { ...ALWAYS, loadedToolNames: [mcp.name] },
		});
		assert.deepStrictEqual({
			offered: (offered ?? []).some(t => t.name === mcp.name),
			deferred: deferred.some(t => t.name === mcp.name),
		}, { offered: true, deferred: false });
	});

	test('XML-описание инструментов при отложенных: блок <deferred_tools> есть, схемы отложенных нет', () => {
		const mcp = mcpTool('jira_create_issue', 'jira');
		const message = chat_systemMessage({
			workspaceFolders: ['/ws'],
			chatMode: 'agent',
			mcpTools: [mcp],
			includeXMLToolDefinitions: true,
			toolSearch: ALWAYS,
		});
		assert.deepStrictEqual({
			hasDeferredBlock: message.includes('<deferred_tools>'),
			listsDeferredName: message.includes('MCP server jira: jira_create_issue'),
			hasDeferredSchema: message.includes(`\n    ${mcp.name}\n`),
			hasToolSearchSchema: message.includes(`\n    ${TOOL_SEARCH_TOOL_NAME}\n`),
		}, { hasDeferredBlock: true, listsDeferredName: true, hasDeferredSchema: false, hasToolSearchSchema: true });
	});
});
