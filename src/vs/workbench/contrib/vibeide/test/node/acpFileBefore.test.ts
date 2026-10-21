/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ACP_BEFORE_MAX_BYTES } from '../../common/acp/acpEditBaseline.js';
// Читает настоящий диск через `fs`, поэтому бежит в Node-раннере
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import { readFileBefore } from '../../electron-main/acp/acpFileBefore.js';

/**
 * Файл в момент, когда агент объявил правку: главный процесс читает его синхронно и сообщает окну
 * Ошибиться здесь значит завести на разбор файл с чужой базой, поэтому всё проверяется на настоящем диске
 */
suite('acpFileBefore — файл до правки внешнего агента', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async function () {
		this.timeout(10_000);
		root = await realpath(await mkdtemp(join(tmpdir(), 'vibe-acp-before-')));
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('существующий файл читается текстом', async () => {
		const path = join(root, 'a.ts');
		await writeFile(path, 'const а = 1;\n');
		assert.deepStrictEqual(readFileBefore(path), { path, state: 'text', text: 'const а = 1;\n' });
	});

	test('файла нет — его создаёт агент', () => {
		const path = join(root, 'нет', 'новый.ts');
		assert.deepStrictEqual(readFileBefore(path), { path, state: 'absent' });
	});

	test('метка порядка байтов не попадает в базу', async () => {
		const path = join(root, 'bom.css');
		await writeFile(path, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('a{}')]));
		assert.deepStrictEqual(readFileBefore(path), { path, state: 'text', text: 'a{}' });
	});

	test('файл не в UTF-8 базы не даёт: мусор отличался бы от модели в каждой строке', async () => {
		const path = join(root, 'win1251.txt');
		await writeFile(path, Buffer.from([0xCF, 0xD0, 0xC8, 0xC2, 0xC5, 0xD2]));
		assert.strictEqual(readFileBefore(path), undefined);
	});

	test('слишком большой файл базы не даёт', async () => {
		const path = join(root, 'big.txt');
		await writeFile(path, Buffer.alloc(ACP_BEFORE_MAX_BYTES + 1, 0x61));
		assert.strictEqual(readFileBefore(path), undefined);
	});

	test('каталог — не файл', async () => {
		const path = join(root, 'dir');
		await mkdir(path);
		assert.strictEqual(readFileBefore(path), undefined);
	});
});
