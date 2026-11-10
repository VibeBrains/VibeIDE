/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveProviderKey } from '../../common/providerKeySources.js';

suite('Provider key sources', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('оба источника: ключ из настроек IDE побеждает переменную окружения', () => {
		assert.deepStrictEqual(
			resolveProviderKey({ guiKey: 'sk-ide', envFileKey: 'sk-env' }),
			{ key: 'sk-ide', source: 'gui', conflict: true },
		);
	});

	test('оба источника: ключ по apiKeyRef побеждает переменную окружения ОС', () => {
		assert.deepStrictEqual(
			resolveProviderKey({ refKey: 'sk-ref', osEnvPresent: true }),
			{ key: 'sk-ref', source: 'ref', conflict: true },
		);
	});

	test('только ключ из настроек IDE — конфликта нет', () => {
		assert.deepStrictEqual(resolveProviderKey({ guiKey: 'sk-ide' }), { key: 'sk-ide', source: 'gui', conflict: false });
	});

	test('только переменная окружения — ключ берётся из неё', () => {
		assert.deepStrictEqual(
			resolveProviderKey({ envFileKey: 'sk-env' }),
			{ key: 'sk-env', source: 'env-file', conflict: false },
		);
	});

	test('ни одного источника — ключа нет', () => {
		assert.deepStrictEqual(resolveProviderKey({}), { source: 'none', conflict: false });
	});
});
