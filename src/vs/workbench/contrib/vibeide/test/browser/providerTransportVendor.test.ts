/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Транспорт файлового провайдера несёт вендора: главный процесс регистрирует провайдера с таблицей моделей вендора

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { dynamicTransportConfigOf } from '../../browser/vibeDynamicProvidersService.js';

suite('Транспорт файлового провайдера — вендор', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('транспорт файлового провайдера несёт вендора: по id и по адресу', () => {
		const transport = (id: string, baseURL: string) => dynamicTransportConfigOf({ id, baseURL }, undefined, {}).vendor;
		assert.deepStrictEqual(
			[transport('anthropic', 'https://api.anthropic.com/v1'), transport('my-claude', 'https://api.anthropic.com/v1'), transport('kimi', 'https://api.moonshot.ai/v1')],
			['anthropic', 'anthropic', undefined],
		);
	});
});
