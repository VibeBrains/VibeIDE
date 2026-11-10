/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { formatAcpCost } from '../../common/acp/acpCost.js';

suite('acpCost', () => {

	test('доллары, другие ISO-коды и свободная единица показываются по-своему', () => {
		assert.deepStrictEqual(
			[formatAcpCost(0.1849, 'USD'), formatAcpCost(0.1849, 'usd'), formatAcpCost(1.5, 'EUR'), formatAcpCost(3, 'credits')],
			['$0.1849', '$0.1849', '1.5000 EUR', '3.0000 credits']);
	});

	test('без единицы остаётся прежняя запись в долларах', () => {
		assert.deepStrictEqual(
			[formatAcpCost(0.1849), formatAcpCost(1, '   ')],
			['$0.1849', '$1.0000']);
	});
});
