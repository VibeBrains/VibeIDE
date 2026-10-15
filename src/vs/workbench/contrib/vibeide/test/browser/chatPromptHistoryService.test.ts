/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ChatPromptHistoryService } from '../../browser/chatPromptHistoryService.js';
import { PROMPT_HISTORY_DEFAULT_MAX, PROMPT_HISTORY_MAX_ENTRY_CHARS } from '../../common/promptHistory.js';

suite('ChatPromptHistoryService — история композера по рабочей папке', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('запомненное доживает до нового окна на той же папке; повтор подряд не плодит запись, пустое и огромное не запоминаются', () => {
		const storage = disposables.add(new InMemoryStorageService());
		const first = disposables.add(new ChatPromptHistoryService(storage));
		first.remember('изучи открытый файл');
		first.remember('изучи открытый файл');
		first.remember('   ');
		first.remember('x'.repeat(PROMPT_HISTORY_MAX_ENTRY_CHARS + 1));
		first.remember('почини сборку');
		const reopened = disposables.add(new ChatPromptHistoryService(storage));
		assert.deepStrictEqual(reopened.entries, ['изучи открытый файл', 'почини сборку']);
	});

	test('старая фраза, сказанная снова, переезжает в конец, а длина списка держится на пределе', () => {
		const storage = disposables.add(new InMemoryStorageService());
		const service = disposables.add(new ChatPromptHistoryService(storage));
		for (let i = 0; i < PROMPT_HISTORY_DEFAULT_MAX + 5; i++) { service.remember(`фраза ${i}`); }
		service.remember('фраза 10');
		assert.deepStrictEqual([service.entries.length, service.entries[service.entries.length - 1], service.entries.includes('фраза 0')], [PROMPT_HISTORY_DEFAULT_MAX, 'фраза 10', false]);
	});
});
