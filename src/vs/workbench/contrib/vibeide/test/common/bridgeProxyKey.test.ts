/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { bridgeProxyKey } from '../../common/vibeServer/bridgeProxyKey.js';

suite('bridgeProxyKey — что считается одним и тем же dev-сервером', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('пути и запрос отбрасываются: два экрана одного приложения — одно приложение', () => {
		assert.deepStrictEqual(
			[
				bridgeProxyKey('http://localhost:5173/'),
				bridgeProxyKey('http://localhost:5173/admin?tab=1'),
			],
			['http://localhost:5173', 'http://localhost:5173'],
		);
	});

	test('разные порты — разные приложения (ради этого весь пул и заведён)', () => {
		assert.notStrictEqual(bridgeProxyKey('http://localhost:5173'), bridgeProxyKey('http://localhost:5174'));
	});

	test('localhost и 127.0.0.1 НЕ склеиваются — это разные адреса при бинде', () => {
		assert.notStrictEqual(bridgeProxyKey('http://localhost:3000'), bridgeProxyKey('http://127.0.0.1:3000'));
	});

	test('регистр хоста и схема не плодят второй прокси; неразборный url остаётся стабильным ключом', () => {
		assert.deepStrictEqual(
			[
				bridgeProxyKey('http://LocalHost:5173'),
				bridgeProxyKey('https://localhost:5173'),
				bridgeProxyKey('  не url  '),
			],
			['http://localhost:5173', 'https://localhost:5173', 'не url'],
		);
	});
});
