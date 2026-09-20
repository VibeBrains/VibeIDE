/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Документ метаданных клиента OAuth: его адрес И ЕСТЬ наш `client_id`.
 *
 * Спека требует точного совпадения значения внутри документа с адресом, по которому он лежит, а
 * сервер авторизации тянет документ по тому адресу, который мы ему назовём в `product.json`. Три
 * места обязаны говорить одно и то же, и разъехаться они могут молча — отсюда этот тест.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/`. */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');
const read = (...parts: string[]) => JSON.parse(readFileSync(join(REPO_ROOT, ...parts), 'utf8'));

suite('oauth clientMetadata — адрес документа и есть идентификатор клиента', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('product.json, сам документ и опубликованный путь совпадают', () => {
		const metadata = read('resources', 'oauth', 'clientMetadata.json');
		const product = read('product.json');
		const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'publish-schemas.yml'), 'utf8');
		assert.deepStrictEqual([
			metadata.client_id,
			product.authClientIdMetadataUrl,
			workflow.includes(`expected="${metadata.client_id}"`),
			// Документ отдаётся по HTTPS и содержит минимум, который спека называет обязательным.
			metadata.client_id.startsWith('https://'),
			typeof metadata.client_name === 'string' && metadata.client_name.length > 0,
			Array.isArray(metadata.redirect_uris) && metadata.redirect_uris.length > 0,
		], [
			metadata.client_id,
			metadata.client_id,
			true,
			true,
			true,
			true,
		]);
	});
});
