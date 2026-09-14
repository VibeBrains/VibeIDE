/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isMcpAppLinkAllowed, isMcpToolCallableByApp, isMcpToolVisibleToModel, mcpAppMessageText, mcpAppsClientCapabilities, mcpAppUiOfTool } from '../../common/mcpApps.js';

/**
 * MCP Apps: какой инструмент рисует приложение, кому он виден, что приложению разрешено.
 */
suite('mcpApps — метаданные и правила MCP Apps', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ресурс и видимость из _meta.ui, старый плоский ключ, чужая схема и умолчания', () => {
		assert.deepStrictEqual([
			mcpAppUiOfTool({ _meta: { ui: { resourceUri: 'ui://clock/app.html', visibility: ['app'] } } }),
			mcpAppUiOfTool({ _meta: { 'ui/resourceUri': 'ui://old/app.html' } }),
			mcpAppUiOfTool({ _meta: { ui: { resourceUri: 'https://evil.example/app.html', visibility: ['model', 'bogus'] } } }),
			mcpAppUiOfTool({}),
		], [
			{ resourceUri: 'ui://clock/app.html', visibility: ['app'] },
			{ resourceUri: 'ui://old/app.html', visibility: ['model', 'app'] },
			{ resourceUri: undefined, visibility: ['model'] },
			{ resourceUri: undefined, visibility: ['model', 'app'] },
		]);
	});

	test('инструмент только для приложения скрыт от модели, только для модели — закрыт приложению', () => {
		const appOnly = { _meta: { ui: { visibility: ['app'] } } };
		const modelOnly = { _meta: { ui: { visibility: ['model'] } } };
		assert.deepStrictEqual(
			[isMcpToolVisibleToModel(appOnly), isMcpToolCallableByApp(appOnly), isMcpToolVisibleToModel(modelOnly), isMcpToolCallableByApp(modelOnly), isMcpToolVisibleToModel({}), isMcpToolCallableByApp({})],
			[false, true, true, false, true, true],
		);
	});

	test('возможность клиента объявляется только при включённых приложениях', () => {
		assert.deepStrictEqual(
			[mcpAppsClientCapabilities(true), mcpAppsClientCapabilities(false)],
			[{ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }, {}],
		);
	});

	test('ссылки только http и https, текст сообщения без нетекстовых блоков', () => {
		assert.deepStrictEqual(
			[isMcpAppLinkAllowed('https://example.com'), isMcpAppLinkAllowed('http://localhost:3000'), isMcpAppLinkAllowed('vscode://auth/callback'), isMcpAppLinkAllowed('не ссылка'),
			mcpAppMessageText([{ type: 'text', text: 'первое' }, { type: 'image' }, { type: 'text', text: 'второе' }])],
			[true, true, false, false, 'первое\n\nвторое'],
		);
	});
});
