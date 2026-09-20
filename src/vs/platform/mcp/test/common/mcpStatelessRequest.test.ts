/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isDiscoverRequest, isStatelessMessage, MCP_META_PROTOCOL_VERSION, statelessProtocolVersionOf } from '../../common/mcpStatelessRequest.js';

const stateless = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [MCP_META_PROTOCOL_VERSION]: '2026-07-28' } } };
const legacy = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const discover = { jsonrpc: '2.0', id: 1, method: 'server/discover' };

suite('mcpStatelessRequest — клиент ревизии 2026-07-28 приходит без сессии', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('версия читается из _meta запроса, а не из рукопожатия', () => {
		assert.deepStrictEqual([
			statelessProtocolVersionOf(stateless),
			statelessProtocolVersionOf([stateless]),
			statelessProtocolVersionOf(legacy),
			statelessProtocolVersionOf({ ...stateless, params: { _meta: { [MCP_META_PROTOCOL_VERSION]: '  ' } } }),
			statelessProtocolVersionOf(undefined),
		], ['2026-07-28', '2026-07-28', undefined, undefined, undefined]);
	});

	test('без сессии обслуживаются запрос новой ревизии и знакомство; старый без рукопожатия — нет', () => {
		assert.deepStrictEqual(
			[isStatelessMessage(stateless), isDiscoverRequest(discover), isStatelessMessage(discover), isStatelessMessage(legacy)],
			[true, true, true, false],
		);
	});
});
