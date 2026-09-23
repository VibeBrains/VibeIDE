/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { promptCacheKeyOf } from '../../common/promptCacheKey.js';

suite('promptCacheKey — ключ кэша разговора', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('один разговор — один ключ на каждом ходу, другой разговор или роль — другой, содержимого в ключе нет', () => {
		const agent = promptCacheKeyOf('thread-1', 'agent');
		assert.deepStrictEqual({
			тотЖе: agent === promptCacheKeyOf('thread-1', 'agent'),
			другойТред: agent === promptCacheKeyOf('thread-2', 'agent'),
			план: agent === promptCacheKeyOf('thread-1', 'plan'),
			форма: /^vibe-[0-9a-f]{32}$/.test(agent),
			безId: agent.includes('thread-1'),
		}, {
			тотЖе: true,
			другойТред: false,
			план: false,
			форма: true,
			безId: false,
		});
	});
});
