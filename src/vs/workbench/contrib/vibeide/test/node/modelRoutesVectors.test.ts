/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Логические имена моделей — общие с VibeIDEA векторы из набора (`.vibe-defaults/testVectors/modelRoutes.json`).
 *
 * Одно имя обязано вести к одной модели в обоих продуктах: блок `routes` лежит в общих файлах провайдеров, и
 * расхождение в слоях или в запрете `null` отправило бы шаг пайплайна к разным моделям. Файл читается через `fs`,
 * поэтому тест живёт в `test/node/`.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mergeModelRoutes, ModelRoutes, resolveModelReference, RouteResolution } from '../../common/modelRouteKeys.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в modelQuirksCatalog.test.ts. */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

type VectorResult =
	| { readonly kind: 'found'; readonly provider: string; readonly model: string }
	| { readonly kind: 'disabled' }
	| { readonly kind: 'unknown'; readonly known: readonly string[] };

interface ModelRoutesVectors {
	readonly layers: readonly ModelRoutes[];
	readonly merged: ModelRoutes;
	readonly resolve: readonly { readonly reference: string; readonly result: VectorResult }[];
}

/** Our resolution in the vectors' terms: a target is split at the first slash, as VibeIDEA splits it */
function asVector(resolution: RouteResolution): VectorResult {
	switch (resolution.kind) {
		case 'disabled': return { kind: 'disabled' };
		case 'unknown-key': return { kind: 'unknown', known: resolution.known };
		default: {
			const slash = resolution.reference.indexOf('/');
			return { kind: 'found', provider: resolution.reference.slice(0, slash), model: resolution.reference.slice(slash + 1) };
		}
	}
}

suite('modelRoutes — общие с VibeIDEA векторы из набора', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const vectors: ModelRoutesVectors = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'modelRoutes.json'), 'utf8'));

	test('слои складываются так же, как в VibeIDEA, и имя ведёт к той же модели', () => {
		const merged = mergeModelRoutes(vectors.layers);
		assert.deepStrictEqual(
			{ merged, resolved: vectors.resolve.map(v => ({ reference: v.reference, result: asVector(resolveModelReference(v.reference, merged)) })) },
			{ merged: vectors.merged, resolved: vectors.resolve.map(v => ({ reference: v.reference, result: v.result })) },
		);
	});
});
