/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ключ настройки `vibeide.*` регистрируется ровно один раз.
 *
 * Реестр настроек второй регистрации того же ключа не принимает и молчит: свойство просто пропадает из узла.
 * Какая из двух записей уцелеет, решает порядок вычисления модулей, а не автор.
 * Так `vibeide.agent.maxLoopIterations` годами значился в коде с умолчанием 30 и 0 одновременно.
 *
 * Проверка читает исходники, а не реестр: в реестре от дубля остаётся одна запись, и увидеть его там уже нельзя.
 * Ключи, собранные из констант (`[SETTING]: {`), она не видит — такие записи стоит держать рядом с константой.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readdirSync, readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в modelRoutesVectors.test.ts. */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');
const VIBEIDE_SOURCES = join(REPO_ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide');

/** Папки, где настроек нет: тесты, зависимости, собранный код. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['test', 'node_modules', 'out']);

/** Строка вида `'vibeide.cost.alwaysConfirm': {` — начало описания настройки в узле конфигурации. */
const SETTING_KEY_LINE = /^\s*'(?<key>vibeide\.[A-Za-z0-9_.]+)': \{/;

interface SettingSource {
	readonly path: string;
	readonly text: string;
}

/** Ключ → места, где он описан; в карту попадают только ключи, описанные больше одного раза. */
function duplicateSettingKeys(sources: readonly SettingSource[]): ReadonlyMap<string, readonly string[]> {
	const places = new Map<string, string[]>();
	for (const { path, text } of sources) {
		if (!text.includes('registerConfiguration(')) {
			continue;
		}
		text.split('\n').forEach((line, index) => {
			const key = SETTING_KEY_LINE.exec(line)?.groups?.['key'];
			if (key) {
				places.set(key, [...(places.get(key) ?? []), `${path}:${index + 1}`]);
			}
		});
	}
	return new Map([...places].filter(([, where]) => where.length > 1));
}

function readSources(directory: string, into: SettingSource[] = []): SettingSource[] {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRECTORIES.has(entry.name)) {
				readSources(join(directory, entry.name), into);
			}
		} else if (entry.name.endsWith('.ts')) {
			const path = join(directory, entry.name);
			into.push({ path: path.slice(VIBEIDE_SOURCES.length + 1), text: readFileSync(path, 'utf8') });
		}
	}
	return into;
}

suite('Настройки vibeide.* — один ключ, одна регистрация', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('сканер находит повтор ключа в разных файлах и внутри одного', () => {
		const duplicates = duplicateSettingKeys([
			{ path: 'a.ts', text: "registerConfiguration({\n\t'vibeide.x.one': {\n\t},\n\t'vibeide.x.two': {\n\t}," },
			{ path: 'b.ts', text: "registerConfiguration({\n\t'vibeide.x.one': {\n\t},\n\t'vibeide.x.two': {\n\t}," },
			{ path: 'c.ts', text: "registerConfiguration({\n\t'vibeide.x.three': {\n\t},\n\t'vibeide.x.three': {\n\t}," },
			{ path: 'd.ts', text: "const notConfiguration = {\n\t'vibeide.x.one': {\n\t}," },
		]);
		assert.deepStrictEqual([...duplicates], [
			['vibeide.x.one', ['a.ts:2', 'b.ts:2']],
			['vibeide.x.two', ['a.ts:4', 'b.ts:4']],
			['vibeide.x.three', ['c.ts:2', 'c.ts:4']],
		]);
	});

	test('в исходниках нет ключа, зарегистрированного дважды', () => {
		const sources = readSources(VIBEIDE_SOURCES);
		// Без этого пустой результат ничего не значил бы: сломанный шаблон строки тоже ничего не находит
		const scanned = sources.reduce((count, { text }) => count + (text.includes('registerConfiguration(') ? text.split('\n').filter(line => SETTING_KEY_LINE.test(line)).length : 0), 0);
		assert.ok(scanned > 100, `сканер увидел только ${scanned} описаний настроек`);
		assert.deepStrictEqual([...duplicateSettingKeys(sources)], []);
	});
});
