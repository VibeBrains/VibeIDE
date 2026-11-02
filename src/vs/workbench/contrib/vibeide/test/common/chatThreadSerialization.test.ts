/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseThreadsFromStorage, serializeThreadsForStorage } from '../../common/chatThreadSerialization.js';

suite('chatThreadSerialization — формат хранения тредов', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('круговой прогон треда с картинкой Uint8Array', () => {
		const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
		const thread = {
			id: 'thread-1',
			messages: [{
				role: 'user',
				content: 'посмотри на картинку',
				displayContent: 'посмотри на картинку',
				images: [{ data: bytes, mimeType: 'image/png' }],
			}],
		};

		const serialized = serializeThreadsForStorage(thread);
		assert.ok(serialized.includes('__base64__:'), 'байты картинки уходят в base64');

		const restored = parseThreadsFromStorage<typeof thread>(serialized);
		const data = restored.messages[0].images[0].data;
		assert.ok(data instanceof Uint8Array, 'байты восстанавливаются как Uint8Array');
		assert.deepStrictEqual(Array.from(data), Array.from(bytes));
	});

	test('URI восстанавливается из маршаллизованного вида', () => {
		const uri = URI.file('/tmp/проект/файл.ts');
		const serialized = serializeThreadsForStorage({ id: 't', files: [uri] });
		const restored = parseThreadsFromStorage<{ files: URI[] }>(serialized);
		assert.ok(URI.isUri(restored.files[0]));
		assert.strictEqual(restored.files[0].toString(), uri.toString());
	});

	test('массив чисел под ключом data тоже становится байтами', () => {
		const restored = parseThreadsFromStorage<{ data: Uint8Array }>(JSON.stringify({ data: [1, 2, 3] }));
		assert.ok(restored.data instanceof Uint8Array);
		assert.deepStrictEqual(Array.from(restored.data), [1, 2, 3]);
	});
});
