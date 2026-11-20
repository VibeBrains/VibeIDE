/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CHAT_MODE_CHOICES } from '../../common/chatPermissionMode.js';
import { CHAT_MODE_CHOICE_DETAIL, CHAT_MODE_CHOICE_LABEL } from '../../common/chatModeChoiceLabels.js';

suite('подписи режимов ChatMode', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('у каждого пункта списка есть имя', () => {
		assert.deepStrictEqual(Object.keys(CHAT_MODE_CHOICE_LABEL).sort(), [...CHAT_MODE_CHOICES].sort());
	});

	test('у каждого пункта списка есть описание', () => {
		assert.deepStrictEqual(
			CHAT_MODE_CHOICES.filter(choice => (CHAT_MODE_CHOICE_DETAIL[choice] ?? '').trim().length === 0),
			[],
		);
	});
});
