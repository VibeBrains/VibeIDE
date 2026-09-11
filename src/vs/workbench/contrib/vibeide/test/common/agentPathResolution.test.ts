/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { pathUnder, resolveAgentPath } from '../../common/agentPathResolution.js';

/**
 * Путь агента разворачивается до любой проверки.
 *
 * Each case is a way a path used to look «inside the workspace» while naming a file outside it —
 * the boundary checked the path as written, and `..` survived both URI constructors.
 */
(isWindows ? suite.skip : suite)('разрешение пути агента', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const root = { uri: URI.file('/proj'), name: 'proj' };
	const resolve = (raw: string) => resolveAgentPath(raw, [root]).fsPath;

	/** The exact shapes that escaped: an absolute path and a `file://` URI, both with `..`. */
	test('`..` в абсолютном пути и в file:// разворачивается до проверки', () => {
		assert.deepStrictEqual({
			абсолютный: resolve('/proj/../../Users/x/.ssh/id_rsa'),
			fileUri: resolve('file:///proj/../../etc/passwd'),
			вложенный: resolve('/proj/src/../../etc/hosts'),
		}, {
			абсолютный: '/Users/x/.ssh/id_rsa',
			fileUri: '/etc/passwd',
			вложенный: '/etc/hosts',
		});
	});

	test('относительный путь по-прежнему разворачивается от корня', () => {
		assert.deepStrictEqual({
			наружу: resolve('../etc/passwd'),
			внутрь: resolve('src/./a.ts'),
		}, { наружу: '/etc/passwd', внутрь: '/proj/src/a.ts' });
	});

	test('обычный путь внутри проекта не меняется, лишние сегменты убираются', () => {
		assert.deepStrictEqual({
			прямой: resolve('/proj/src/a.ts'),
			сТочками: resolve('/proj/src/./lib/../a.ts'),
		}, { прямой: '/proj/src/a.ts', сТочками: '/proj/src/a.ts' });
	});

	/**
	 * The re-rooting heuristic survives, and cannot be used to escape: a model writing `/proj/src`
	 * for `<root>/src` still lands in the project, and `/proj/../../etc` resolves to `/etc` whatever
	 * branch it took.
	 */
	test('эвристика «/имя-проекта/…» сохранена и не выводит наружу', () => {
		const nested = { uri: URI.file('/work/proj'), name: 'proj' };
		assert.deepStrictEqual({
			переукоренён: resolveAgentPath('/proj/src/a.ts', [nested]).fsPath,
			корень: resolveAgentPath('/proj', [nested]).fsPath,
			побег: resolveAgentPath('/proj/../../etc/passwd', [nested]).fsPath,
			уже_внутри: resolveAgentPath('/work/proj/src/a.ts', [nested]).fsPath,
		}, {
			переукоренён: '/work/proj/src/a.ts',
			корень: '/work/proj',
			побег: '/etc/passwd',
			уже_внутри: '/work/proj/src/a.ts',
		});
	});

	test('без рабочей области путь остаётся как есть, но развёрнутым', () => {
		assert.strictEqual(resolveAgentPath('/a/b/../c', []).fsPath, '/a/c');
	});

	/**
	 * «Под корнем» — только по границе папки, и регистр сворачивается, только когда попросили: для
	 * запретов на APFS `/proj` и `/Proj` — одна папка, для разрешений — нет.
	 */
	test('pathUnder: граница папки и регистр', () => {
		const proj = URI.file('/Proj');
		assert.deepStrictEqual({
			внутри: pathUnder(proj, URI.file('/Proj/src/a.ts'), false),
			корень: pathUnder(proj, URI.file('/Proj'), false),
			сосед: pathUnder(proj, URI.file('/Proj-evil/a.ts'), false),
			регистрТочно: pathUnder(proj, URI.file('/proj/src/a.ts'), false),
			регистрСвёрнут: pathUnder(proj, URI.file('/proj/src/a.ts'), true),
		}, { внутри: 'src/a.ts', корень: '', сосед: undefined, регистрТочно: undefined, регистрСвёрнут: 'src/a.ts' });
	});
});
