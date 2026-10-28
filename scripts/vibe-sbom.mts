/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Единый генератор sbom.json для релиза (CycloneDX).
 * Зовут оба workflow: release.yml (сборка релиза) и sbom.yml (после публикации релиза).
 *
 * Зависимости берутся из package-lock.json, а не из node_modules:
 * Сборка, в которой node_modules нет или он частичный, всё равно даёт полный список
 * Пустой список не пишется никогда: нет компонентов — скрипт падает, а не публикует заглушку
 *
 * Usage:
 *   node scripts/vibe-sbom.mts --version v1.29.0 [--output sbom.json]
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

/** Версия генератора закреплена: без неё npx берёт свежую, и вывод плывёт между релизами */
const CYCLONEDX_NPM_PACKAGE = '@cyclonedx/cyclonedx-npm@6.0.1';

/** Ниже этого числа npm-компонентов список считается пустым провалом генерации (у v1.28.0 было 1394) */
export const MIN_NPM_COMPONENTS = 100;

/** Модели и расширения, которые продукт упоминает, но npm их не видит */
interface SbomDocument {
	components?: unknown[];
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}

const AI_MODELS = [
	{
		type: 'machine-learning-model',
		name: 'claude-3-5-sonnet (via API)',
		supplier: { name: 'Anthropic' },
		licenses: [{ license: { name: 'Commercial API — see Anthropic ToS' } }],
		properties: [{ name: 'trainingPolicy', value: 'opt-out-available' }]
	},
	{
		type: 'machine-learning-model',
		name: 'gpt-4o (via API)',
		supplier: { name: 'OpenAI' },
		licenses: [{ license: { name: 'Commercial API — see OpenAI ToS' } }],
		properties: [{ name: 'trainingPolicy', value: 'opt-out-available' }]
	},
	{
		type: 'machine-learning-model',
		name: 'Ollama local models',
		supplier: { name: 'Various (open-source)' },
		description: 'Local models via Ollama — see individual model licenses',
		properties: [{ name: 'trainingPolicy', value: 'none' }]
	}
];

const BUNDLED_EXTENSIONS = [
	{
		type: 'library',
		name: 'vscode-project-manager',
		version: 'latest',
		licenses: [{ license: { id: 'GPL-3.0-only' } }],
		description: 'Bundled as pre-installed extension (independent license)',
		properties: [{ name: 'bundleType', value: 'pre-installed-vsix' }]
	}
];

/**
 * Дополняет npm-SBOM метаданными продукта, моделями и встроенными расширениями.
 * Бросает ошибку, если npm-компонентов меньше порога.
 */
export function buildSbom(npmBom: SbomDocument, version: string, timestamp: string): SbomDocument {
	const npmComponents = Array.isArray(npmBom?.components) ? npmBom.components : [];
	if (npmComponents.length < MIN_NPM_COMPONENTS) {
		throw new Error(`npm-компонентов ${npmComponents.length}, ожидалось не меньше ${MIN_NPM_COMPONENTS}: SBOM не публикуется пустым`);
	}
	return {
		...npmBom,
		metadata: {
			...npmBom.metadata,
			timestamp,
			component: {
				type: 'application',
				name: 'VibeIDE',
				version,
				description: 'Open-source AI IDE — transparency and control',
				licenses: [{ license: { id: 'MIT' } }]
			}
		},
		components: [...npmComponents, ...AI_MODELS, ...BUNDLED_EXTENSIONS]
	};
}

/** Запускает cyclonedx-npm по package-lock.json и возвращает разобранный BOM */
function generateNpmBom(): SbomDocument {
	const dir = mkdtempSync(join(tmpdir(), 'vibe-sbom-'));
	const file = join(dir, 'sbom-npm.json');
	try {
		const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
		const result = spawnSync(
			npx,
			['--yes', CYCLONEDX_NPM_PACKAGE, '--package-lock-only', '--ignore-npm-errors', '--output-format', 'JSON', '--output-file', file],
			{ stdio: 'inherit', shell: process.platform === 'win32' }
		);
		if (result.status !== 0) {
			throw new Error(`cyclonedx-npm завершился с кодом ${result.status}`);
		}
		return JSON.parse(readFileSync(file, 'utf8'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function argValue(name: string): string | null {
	const i = argv.indexOf(name);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function main(): void {
	const version = argValue('--version') || process.env.VIBE_VERSION;
	const output = argValue('--output') || 'sbom.json';
	if (!version) {
		console.error('vibe-sbom: не задан --version и нет VIBE_VERSION');
		process.exit(1);
	}
	const sbom = buildSbom(generateNpmBom(), version, new Date().toISOString());
	writeFileSync(output, JSON.stringify(sbom, null, 2));
	console.log(`SBOM generated with ${(sbom.components ?? []).length} components -> ${output}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		main();
	} catch (e) {
		console.error(`vibe-sbom: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(1);
	}
}
