/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Self-contained smoke test for scripts/vibe-sbom.mts.
// Run: `node scripts/vibe-sbom.test.mts`. No deps.

import assert from 'node:assert/strict';
import { buildSbom, MIN_NPM_COMPONENTS } from './vibe-sbom.mts';

let passed = 0;
function test(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (e) {
		console.error(`FAIL - ${name}\n  ${e instanceof Error ? e.message : String(e)}`);
		process.exitCode = 1;
	}
}

const npmBom = (count: number) => ({
	bomFormat: 'CycloneDX',
	specVersion: '1.6',
	metadata: { tools: [] },
	components: Array.from({ length: count }, (_: unknown, i: number) => ({ type: 'library', name: `pkg${i}`, version: '1.0.0' }))
});

test('пустой npm-список — ошибка, а не заглушка', () => {
	assert.throws(() => buildSbom(npmBom(0), 'v1.0.0', 'T'), /не публикуется пустым/);
	assert.throws(() => buildSbom({ bomFormat: 'CycloneDX' }, 'v1.0.0', 'T'), /не публикуется пустым/);
});

test('список ниже порога — ошибка', () => {
	assert.throws(() => buildSbom(npmBom(MIN_NPM_COMPONENTS - 1), 'v1.0.0', 'T'), /не публикуется пустым/);
});

test('к npm-компонентам добавлены модели и встроенное расширение', () => {
	const sbom = buildSbom(npmBom(MIN_NPM_COMPONENTS), 'v1.29.0', '2026-10-28T00:00:00.000Z');
	assert.equal(sbom.components!.length, MIN_NPM_COMPONENTS + 4);
	assert.equal((sbom.components as Array<{ type: string; name: string }>).filter(c => c.type === 'machine-learning-model').length, 3);
	assert.ok((sbom.components as Array<{ type: string; name: string }>).some(c => c.name === 'vscode-project-manager'));
});

test('метаданные продукта проставлены, прочие поля npm-BOM сохранены', () => {
	const sbom = buildSbom(npmBom(MIN_NPM_COMPONENTS), 'v1.29.0', '2026-10-28T00:00:00.000Z');
	assert.equal(sbom.bomFormat, 'CycloneDX');
	assert.equal(sbom.specVersion, '1.6');
	assert.equal((sbom.metadata as { timestamp: string }).timestamp, '2026-10-28T00:00:00.000Z');
	assert.equal((sbom.metadata as { component: { name: string; version: string } }).component.name, 'VibeIDE');
	assert.equal((sbom.metadata as { component: { name: string; version: string } }).component.version, 'v1.29.0');
	assert.deepEqual((sbom.metadata as { tools: unknown[] }).tools, []);
});

console.log(`${passed} passed`);
