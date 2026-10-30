/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Версия набора в отчёте «было → стало»: «было» читается из шапки копии пользователя,
// «стало» — из реестра ревизий. Эти тесты стерегут два места версии по контракту набора
// (вложенно у навыка, верхним уровнем у правила) и то, что реестр без поля не ломает diff.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { diffVibeDefaults, formatVibeVersionChange, vibeSeedFileVersion } from '../../common/vibeDefaults.js';
import { VIBE_DEFAULTS_MANIFEST, VibeSeedRevision } from '../../common/vibeDefaultsManifest.generated.js';

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.replace(/\r\n/g, '\n')));
	return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fileServiceWith(files: ReadonlyMap<string, string>): IFileService {
	return {
		async readFile(uri: URI) {
			const content = files.get(uri.path);
			if (content === undefined) {
				throw new Error(`ENOENT: ${uri.path}`);
			}
			return { value: VSBuffer.fromString(content) };
		},
	} as unknown as IFileService;
}

const SKILL_PATH = 'skills/anti-slop/SKILL.md';
const RULE_PATH = 'rules/brigadier.mdc';

suite('vibeDefaults — версии набора «было → стало»', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('у навыка версия читается из metadata.vibeVersion', () => {
		const text = `---\nname: demo\ndescription: Demo.\nmetadata:\n  vibeVersion: "1.2.0"\n---\n\nТело\n`;
		assert.strictEqual(vibeSeedFileVersion(SKILL_PATH, text), '1.2.0');
	});

	test('верхний уровень навыка остаётся совместимым', () => {
		const text = `---\nname: demo\ndescription: Demo.\nvibeVersion: 1.0.0\n---\n\nТело\n`;
		assert.strictEqual(vibeSeedFileVersion(SKILL_PATH, text), '1.0.0');
	});

	test('у правила версия читается ключом верхнего уровня', () => {
		const text = `---\ndescription: Правило.\nalwaysApply: false\nvibeVersion: "1.0.0"\n---\n\nТекст\n`;
		assert.strictEqual(vibeSeedFileVersion(RULE_PATH, text), '1.0.0');
	});

	test('версия формата JSON-файла не выдаётся за версию набора', () => {
		assert.strictEqual(vibeSeedFileVersion('agents.json', '{\n\t"vibeVersion": "3"\n}'), undefined);
	});

	test('файл без шапки версии не имеет', () => {
		assert.strictEqual(vibeSeedFileVersion(SKILL_PATH, '# Просто заголовок\n'), undefined);
	});

	test('отсутствующая сторона показывается прочерком', () => {
		assert.strictEqual(formatVibeVersionChange(undefined, '1.2.0'), '— → 1.2.0');
		assert.strictEqual(formatVibeVersionChange('1.0.0', undefined), '1.0.0 → —');
	});

	test('diff отдаёт «было» из шапки и «стало» из реестра для нетронутого навыка', async () => {
		const release = VIBE_DEFAULTS_MANIFEST.find(f => f.path === SKILL_PATH);
		assert.ok(release, 'в манифесте нет навыка anti-slop — тест потерял опору');
		const local = `---\nname: anti-slop\ndescription: Старая копия.\nmetadata:\n  vibeVersion: "0.9.0"\n---\n\nСтарое тело\n`;
		const revisions: VibeSeedRevision[] = [{
			path: SKILL_PATH,
			version: 2,
			sha256: await sha256Hex(release!.contents),
			history: [await sha256Hex(local)],
			vibeVersion: '1.0.1',
		}];
		const diff = await diffVibeDefaults(fileServiceWith(new Map([[`/ws/.vibe/${SKILL_PATH}`, local]])), URI.file('/ws/.vibe'), revisions);
		const entry = diff.entries.find(e => e.path === SKILL_PATH)!;
		assert.deepStrictEqual(
			{ status: entry.status, from: entry.localVersion, to: entry.releaseVersion },
			{ status: 'outdated', from: '0.9.0', to: '1.0.1' });
	});

	test('diff отдаёт версию правила с верхнего уровня шапки', async () => {
		const release = VIBE_DEFAULTS_MANIFEST.find(f => f.path === RULE_PATH);
		assert.ok(release, 'в манифесте нет правила brigadier — тест потерял опору');
		const local = `---\ndescription: Правило.\nalwaysApply: false\nvibeVersion: "0.4.0"\n---\n\nСтарый текст\n`;
		const revisions: VibeSeedRevision[] = [{
			path: RULE_PATH,
			version: 2,
			sha256: await sha256Hex(release!.contents),
			history: [await sha256Hex(local)],
			vibeVersion: '1.0.0',
		}];
		const diff = await diffVibeDefaults(fileServiceWith(new Map([[`/ws/.vibe/${RULE_PATH}`, local]])), URI.file('/ws/.vibe'), revisions);
		const entry = diff.entries.find(e => e.path === RULE_PATH)!;
		assert.deepStrictEqual(
			{ status: entry.status, from: entry.localVersion, to: entry.releaseVersion },
			{ status: 'outdated', from: '0.4.0', to: '1.0.0' });
	});

	test('у отсутствующего файла «было» нет, «стало» из реестра остаётся', async () => {
		const revisions: VibeSeedRevision[] = [{
			path: SKILL_PATH,
			version: 2,
			sha256: await sha256Hex('что угодно'),
			history: [],
			vibeVersion: '2.0.0',
		}];
		const diff = await diffVibeDefaults(fileServiceWith(new Map()), URI.file('/ws/.vibe'), revisions);
		const entry = diff.entries.find(e => e.path === SKILL_PATH)!;
		assert.deepStrictEqual(
			{ status: entry.status, from: entry.localVersion, to: entry.releaseVersion },
			{ status: 'missing', from: undefined, to: '2.0.0' });
	});

	test('реестр без vibeVersion не ломает diff — «стало» остаётся прочерком', async () => {
		const release = VIBE_DEFAULTS_MANIFEST.find(f => f.path === SKILL_PATH)!;
		const revisions: VibeSeedRevision[] = [{
			path: SKILL_PATH,
			version: 2,
			sha256: await sha256Hex(release.contents),
			history: [],
		}];
		const diff = await diffVibeDefaults(fileServiceWith(new Map([[`/ws/.vibe/${SKILL_PATH}`, release.contents]])), URI.file('/ws/.vibe'), revisions);
		const entry = diff.entries.find(e => e.path === SKILL_PATH)!;
		assert.strictEqual(entry.status, 'same');
		assert.strictEqual(entry.releaseVersion, undefined);
		assert.ok(entry.localVersion, 'шапка релиза должна дать «было»');
		assert.ok(formatVibeVersionChange(entry.localVersion, entry.releaseVersion).endsWith(' → —'));
	});
});
