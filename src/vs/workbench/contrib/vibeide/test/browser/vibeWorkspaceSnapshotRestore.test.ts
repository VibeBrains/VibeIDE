/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
// Служба живёт в electron-browser, потому что ходит в git через главный процесс; здесь проверяется только её сверка с редактором
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import { VibeWorkspaceSnapshotService } from '../../electron-browser/vibeWorkspaceSnapshotService.js';

/**
 * Возврат папки к чекпоинту и правки на разборе: зона, поставленная до возврата, после него врёт
 * Проверяется, что редактор после возврата сверен с диском, а файлы вне возврата не тронуты
 */
suite('VibeWorkspaceSnapshotService — возврат папки и разбор правок', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const root = '/ws/app';
	const fsPathOf = (relative: string) => URI.joinPath(URI.file(root), relative).fsPath;

	function setup(options: { zones: string[]; failReload?: boolean }) {
		const steps: string[] = [];
		const service = disposables.add(new VibeWorkspaceSnapshotService(
			{ restoreWorkspaceSnapshot: async () => ({ restore: ['src/a.ts', 'src/b.ts'], delete: ['src/new.ts'], changed: [] }) } as never,
			{ getWorkspace: () => ({ folders: [{ uri: URI.file(root) }] }) } as never,
			{
				diffAreasOfURI: Object.fromEntries(options.zones.map(relative => [fsPathOf(relative), new Set(['1'])])),
				acceptOrRejectAllDiffAreas: async (opts: { uri: URI; behavior: string; removeCtrlKs: boolean; _addToHistory?: boolean }) => {
					steps.push(`${opts.behavior} ${opts.uri.fsPath} history=${opts._addToHistory}`);
				},
			} as never,
			{
				files: {
					resolve: async (uri: URI, resolveOptions: { reload: { async: boolean } }) => {
						steps.push(`reload ${uri.fsPath} async=${resolveOptions.reload.async}`);
						if (options.failReload) { throw new Error('файла нет'); }
					},
				},
			} as never,
		));
		return { service, steps };
	}

	test('зона на возвращённом файле снимается без изменения текста и без записи в историю, затем модель берёт текст с диска', async () => {
		const { service, steps } = setup({ zones: ['src/a.ts'] });
		await service.restore('tree');
		assert.deepStrictEqual(steps, [
			`accept ${fsPathOf('src/a.ts')} history=false`,
			`reload ${fsPathOf('src/a.ts')} async=false`,
		]);
	});

	test('файл вне возврата и файл без зоны не трогаются', async () => {
		const { service, steps } = setup({ zones: ['src/other.ts'] });
		await service.restore('tree');
		assert.deepStrictEqual(steps, []);
	});

	test('файл, удалённый возвратом: зона снята, а что файла нет — не ошибка', async () => {
		const { service, steps } = setup({ zones: ['src/new.ts'], failReload: true });
		await service.restore('tree');
		assert.deepStrictEqual(steps, [
			`accept ${fsPathOf('src/new.ts')} history=false`,
			`reload ${fsPathOf('src/new.ts')} async=false`,
		]);
	});
});
