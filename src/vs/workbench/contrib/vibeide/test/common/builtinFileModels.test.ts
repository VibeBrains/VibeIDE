/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { withBuiltinFileModels, withoutFileModels } from '../../common/builtinFileModels.js';
import type { VibeideStatefulModelInfo } from '../../common/vibeideSettingsTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/**
 * Список моделей встроенного провайдера в настройках: каталог плюс `static`-модели файла, которых в каталоге нет
 * Образец — MiniMax: каталог отдаёт линейку M, а M3.1 Flash Preview и Text-01 приходят только из minimax.jsonc
 */
suite('withBuiltinFileModels — модели файла в списке встроенного провайдера', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const catalogue: VibeideStatefulModelInfo[] = [
		{ modelName: 'MiniMax-M3', type: 'autodetected', isHidden: false },
		{ modelName: 'MiniMax-M2', type: 'autodetected', isHidden: true },
	];
	const fileStatic = [{ id: 'MiniMax-M3.1-Flash-Preview', name: 'Flash' }, { id: 'MiniMax-Text-01' }];
	const row = (m: VibeideStatefulModelInfo) => `${m.modelName} | ${m.type} | ${m.isHidden ? 'скрыта' : 'видна'} | ${m.fileNote ?? '—'}`;

	test('модели файла идут после каталога, видны по умолчанию и несут пометку файла', () => {
		assert.deepStrictEqual(withBuiltinFileModels(catalogue, fileStatic, undefined).map(row), [
			'MiniMax-M3 | autodetected | видна | —',
			'MiniMax-M2 | autodetected | скрыта | —',
			'MiniMax-M3.1-Flash-Preview | autodetected | видна | manual',
			'MiniMax-Text-01 | autodetected | видна | manual',
		]);
	});

	test('тот же id в каталоге и в файле — одна строка, каталожная, без пометки', () => {
		const rows = withBuiltinFileModels(catalogue, [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2' }, { id: 'MiniMax-M3' }], undefined);
		assert.deepStrictEqual(rows.map(row), [
			'MiniMax-M3 | autodetected | видна | —',
			'MiniMax-M2 | autodetected | скрыта | —',
		]);
	});

	test('повтор id внутри файла не даёт двойника', () => {
		const rows = withBuiltinFileModels([], [{ id: 'a' }, { id: 'a' }], undefined);
		assert.deepStrictEqual(rows.map(row), ['a | autodetected | видна | manual']);
	});

	test('выбор пользователя из карты скрытых побеждает умолчание', () => {
		const rows = withBuiltinFileModels(catalogue, fileStatic, { 'MiniMax-Text-01': true, 'MiniMax-M3.1-Flash-Preview': false });
		assert.deepStrictEqual(rows.slice(2).map(row), [
			'MiniMax-M3.1-Flash-Preview | autodetected | видна | manual',
			'MiniMax-Text-01 | autodetected | скрыта | manual',
		]);
	});

	test('убранная из файла модель исчезает из списка, каталожные остаются', () => {
		const withFile = withBuiltinFileModels(catalogue, fileStatic, undefined);
		assert.deepStrictEqual(withBuiltinFileModels(withFile, undefined, undefined).map(row), catalogue.map(row));
	});

	test('ничего не изменилось — вернётся тот же массив, пересборка состояния не нужна', () => {
		assert.strictEqual(withBuiltinFileModels(catalogue, undefined, undefined), catalogue);
		const withFile = withBuiltinFileModels(catalogue, fileStatic, undefined);
		assert.strictEqual(withBuiltinFileModels(withFile, fileStatic, undefined), withFile);
	});

	test('в хранилище уходят только свои модели: производные от файла отбрасываются', () => {
		const withFile = withBuiltinFileModels(catalogue, fileStatic, undefined);
		assert.deepStrictEqual(withoutFileModels(withFile).map(row), catalogue.map(row));
		assert.strictEqual(withoutFileModels(catalogue), catalogue);
	});
});
