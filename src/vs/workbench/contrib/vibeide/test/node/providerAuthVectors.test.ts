/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ключ, локальный адрес и каталог провайдера из файла — общие с VibeIDEA векторы из набора
 * (`.vibe-defaults/testVectors/providerAuth.json`).
 *
 * Векторы лежат в VibeBrains, а не копией здесь: одна запись providers.json обязана ходить к серверу в обоих
 * продуктах одинаково, а копия правила у каждого продукта расходится молча. Файл читается через `fs`,
 * поэтому тест живёт в `test/node/`.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isLocalAddress } from '../../common/isLocalProvider.js';
import { catalogRequestOf, keyPlacement, VibeCatalogSource, VibeProviderEntry, VibeProviderProtocol } from '../../common/vibeProvidersFile.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в modelQuirksCatalog.test.ts. */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

interface ProviderAuthVectors {
	readonly localAddress: readonly { readonly baseURL: string; readonly local: boolean }[];
	readonly placement: readonly {
		readonly name: string;
		readonly auth?: VibeProviderEntry['auth'];
		readonly wire: VibeProviderProtocol;
		readonly key: string | null;
		readonly headers: Record<string, string>;
		readonly query: Record<string, string>;
	}[];
	readonly catalog: readonly {
		readonly name: string;
		readonly provider: Omit<VibeCatalogSource, 'modelsUrl'> & { readonly models?: { readonly fetch?: string } };
		readonly key: string | null;
		readonly url: string;
		readonly headers: Record<string, string>;
	}[];
}

suite('providerAuth — общие с VibeIDEA векторы из набора', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const vectors: ProviderAuthVectors = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'providerAuth.json'), 'utf8'));

	test('локальный адрес узнаётся так же, как в VibeIDEA', () => {
		assert.deepStrictEqual(
			vectors.localAddress.map(v => ({ baseURL: v.baseURL, local: isLocalAddress(v.baseURL) })),
			vectors.localAddress.map(v => ({ baseURL: v.baseURL, local: v.local })),
		);
	});

	test('ключ уходит туда же, куда в VibeIDEA', () => {
		assert.deepStrictEqual(
			vectors.placement.map(v => ({ name: v.name, placement: keyPlacement(v.auth, v.key ?? undefined, v.wire) })),
			vectors.placement.map(v => ({ name: v.name, placement: { headers: v.headers, query: v.query } })),
		);
	});

	test('каталог спрашивается тем же запросом, что в VibeIDEA', () => {
		assert.deepStrictEqual(
			vectors.catalog.map(v => {
				const { models, ...provider } = v.provider;
				return { name: v.name, request: catalogRequestOf({ ...provider, modelsUrl: models?.fetch }, v.key ?? undefined) };
			}),
			vectors.catalog.map(v => ({ name: v.name, request: { url: v.url, headers: v.headers } })),
		);
	});
});
