/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getCodespanDisplayText } from '../../common/markdownCodespanPath.js';

suite('markdownCodespanPath — inline-код с путями', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('абсолютный путь к файлу не сокращается до basename', () => {
		assert.strictEqual(getCodespanDisplayText('/tmp/a/b/file.txt'), '/tmp/a/b/file.txt');
	});

	test('путь к папке с завершающим слешем не становится пустой подписью', () => {
		assert.strictEqual(getCodespanDisplayText('/tmp/a/b/'), '/tmp/a/b/');
	});

	test('путь к папке без слеша и путь с ~ обрабатываются согласованно', () => {
		assert.strictEqual(getCodespanDisplayText('/tmp/a/b'), '/tmp/a/b');
		assert.strictEqual(getCodespanDisplayText('~/a/b/file.txt'), '~/a/b/file.txt');
	});
});
