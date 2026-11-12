/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandPathScope, commandPathsOutsideScope, describeOutsidePaths } from '../../common/commandPathsOutsideScope.js';

const scope = (roots: readonly string[], caseInsensitive = true): ICommandPathScope => ({ roots, caseInsensitive });
const outside = (command: string, roots: readonly string[] = ['/Users/a/proj'], caseInsensitive = true) => commandPathsOutsideScope(command, scope(roots, caseInsensitive));
const table = (command: string, roots?: readonly string[], caseInsensitive?: boolean) => outside(command, roots, caseInsensitive).map(item => `${item.path}:${item.critical}`);

suite('commandPathsOutsideScope — пути в аргументах команды вне проекта', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('абсолютный путь в аргументе вне проекта: инцидент с --save /VolumES', () => {
		assert.deepStrictEqual(
			outside('npm run compare:brandbook -- --save /VolumES'),
			[{ path: '/VolumES', critical: true, readOnly: false }]);
	});

	test('значение опции читается и у --opt=/path, и у -o/path', () => {
		assert.deepStrictEqual(
			[
				table('npm run compare:brandbook --save=/Volumes/ExVint/work'),
				table('tool -o/Volumes/ExVint/work'),
			],
			[['/Volumes/ExVint/work:false'], ['/Volumes/ExVint/work:false']]);
	});

	test('путь в проекте, временный каталог, служебное устройство и URL остаются своими', () => {
		assert.deepStrictEqual(
			[
				table('cat /Users/a/proj/src/a.ts'),
				table('cp a /tmp/x'),
				table('cat /dev/null'),
				table('curl https://x.y/z'),
			],
			[[], [], [], []]);
	});

	test('регистр сравнивается без учёта на macOS и Windows и с учётом на Linux', () => {
		assert.deepStrictEqual(
			[
				table('ls /USERS/A/PROJ/src', ['/Users/a/proj'], true),
				table('ls /USERS/A/PROJ/src', ['/Users/a/proj'], false),
			],
			[[], ['/USERS/A/PROJ/src:false']]);
	});

	test('домашний каталог всегда вне проекта и критичен', () => {
		assert.deepStrictEqual(
			[table('rm -rf ~'), table('cp a $HOME/x')],
			[['~:true'], ['$HOME/x:false']]);
	});

	test('буква диска: путь в проекте свой, корень диска критичен', () => {
		assert.deepStrictEqual(
			[
				table('dir C:\\Users\\a\\proj\\x', ['C:\\Users\\a\\proj'], true),
				table('dir D:\\', ['C:\\Users\\a\\proj'], true),
			],
			[[], ['D:\\:true']]);
	});

	test('относительный выход вверх внешний, но не критичный: каталог строки неизвестен', () => {
		assert.deepStrictEqual(table('cp a ../other/file'), ['../other/file:false']);
	});

	test('чтение системного файла тоже вне проекта: решает вызывающий', () => {
		assert.deepStrictEqual(table('cat /etc/hosts'), ['/etc/hosts:false']);
	});

	test('системный каталог и том критичны сами, а вложенный путь — нет', () => {
		assert.deepStrictEqual(
			[
				table('rm -rf /'),
				table('rm -rf /Volumes'),
				table('rm -rf /Volumes/Ext'),
				table('rm -rf /media/me/disk'),
				table('rm -rf /System'),
				table('rm -rf /usr/local/bin'),
			],
			[['/:true'], ['/Volumes:true'], ['/Volumes/Ext:true'], ['/media/me/disk:true'], ['/System:true'], ['/usr/local/bin:false']]);
	});

	test('дубли путей убираются, порядок остаётся как в команде', () => {
		assert.deepStrictEqual(
			table('cp /Volumes/x /tmp/y --save=/Volumes/x ../z ../z'),
			['/Volumes/x:true', '../z:false']);
	});

	test('описание называет путь и помечает корень диска или домашней папки', () => {
		const text = describeOutsidePaths(outside('npm run x -- --save /VolumES ../other'));
		assert.ok(text.includes('«/VolumES» — корень диска или домашней папки'));
		assert.ok(text.includes('«../other»'));
	});
});
