/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EXTERNAL_ACCESS_TTL_KEY, isPathAllowed, normalizeFolderPath, resolveSourceFolders, liveGrants, revokedFoldersAfterGrant, VibeExternalAccessService } from '../../common/vibeExternalAccessService.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IVibeModalService } from '../../common/vibeModalService.js';

suite('vibeExternalAccess — per-folder allowlist (O.13 Variant A)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('exact folder match is allowed', () => {
		assert.strictEqual(isPathAllowed('/a/proj', ['/a/proj'], true), true);
	});

	test('file inside an allowed folder is allowed', () => {
		assert.strictEqual(isPathAllowed('/a/proj/src/x.ts', ['/a/proj'], true), true);
	});

	test('folder BOUNDARY — no substring leak', () => {
		// Allowing /a/proj must NOT allow the sibling /a/project-secret.
		assert.strictEqual(isPathAllowed('/a/project-secret/x', ['/a/proj'], true), false);
	});

	test('unrelated path is denied', () => {
		assert.strictEqual(isPathAllowed('/b/other/x', ['/a/proj'], true), false);
	});

	test('trailing slash on the allowed folder is tolerated', () => {
		assert.strictEqual(isPathAllowed('/a/proj/x', ['/a/proj/'], true), true);
	});

	test('backslash paths normalize to forward-slash for matching', () => {
		assert.strictEqual(isPathAllowed('C:\\a\\proj\\x.ts', ['C:/a/proj'], false), true);
	});

	test('case sensitivity honored', () => {
		assert.strictEqual(isPathAllowed('/A/Proj/x', ['/a/proj'], false), true);  // win-style: case-insensitive
		assert.strictEqual(isPathAllowed('/A/Proj/x', ['/a/proj'], true), false);  // posix: case-sensitive
	});

	test('empty allowlist denies everything', () => {
		assert.strictEqual(isPathAllowed('/a/proj/x', [], true), false);
	});

	test('empty folder entry never matches (no match-all)', () => {
		assert.strictEqual(isPathAllowed('/a/proj/x', ['', '   '.trim()], true), false);
	});

	test('normalizeFolderPath strips trailing slashes and lowercases when case-insensitive', () => {
		assert.strictEqual(normalizeFolderPath('C:\\A\\B\\', false), 'c:/a/b');
		assert.strictEqual(normalizeFolderPath('/A/B/', true), '/A/B');
	});
});

suite('vibeExternalAccess — reference folders are read-only', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a reference folder answers yes to read and no to write', () => {
		const writable = ['/work/project'];
		const reference = ['/home/notes'];
		const readFolders = [...writable, ...reference];
		assert.deepStrictEqual(
			{
				readInReference: isPathAllowed('/home/notes/idea.md', readFolders, true),
				writeInReference: isPathAllowed('/home/notes/idea.md', writable, true),
				writeInAllowlist: isPathAllowed('/work/project/a.ts', writable, true),
				// Boundary, not substring: allowing /home/notes must not leak /home/notes-secret.
				neighbour: isPathAllowed('/home/notes-secret/x.md', readFolders, true),
			},
			{ readInReference: true, writeInReference: false, writeInAllowlist: true, neighbour: false },
		);
	});
});

suite('vibeExternalAccess — source folders inside the workspace', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a relative entry expands against EVERY workspace root', () => {
		// Expanding only the first root would leave the other projects writable — silently, which
		// is the exact failure this setting exists to prevent.
		assert.deepStrictEqual(
			resolveSourceFolders(['raw'], ['/w/one', '/w/two']),
			['/w/one/raw', '/w/two/raw'],
		);
	});

	test('junk entries are dropped instead of matching everything', () => {
		// An empty or `..` entry resolved to the root itself would freeze the whole project.
		assert.deepStrictEqual(
			resolveSourceFolders(['', '   ', '../escape', './docs/sources/', 'raw\\nested'], ['/w']),
			['/w/docs/sources', '/w/raw/nested'],
		);
	});

	test('absolute entries pass through untouched', () => {
		assert.deepStrictEqual(
			resolveSourceFolders(['/mnt/archive', 'C:\\corpus'], ['/w']),
			['/mnt/archive', 'C:\\corpus'],
		);
	});

	test('protection covers the folder and its contents, and stops at the boundary', () => {
		const folders = resolveSourceFolders(['raw'], ['/w']);
		assert.deepStrictEqual(
			{
				folder: isPathAllowed('/w/raw', folders, true),
				inside: isPathAllowed('/w/raw/talks/2026.md', folders, true),
				lookalike: isPathAllowed('/w/raw-notes/x.md', folders, true),
				elsewhere: isPathAllowed('/w/docs/x.md', folders, true),
			},
			{ folder: true, inside: true, lookalike: false, elsewhere: false },
		);
	});
});

suite('vibeExternalAccess — путь сравнивается развёрнутым', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * A path compared as written: `..` let a file inside a source folder look like it was elsewhere,
	 * and a file outside an allowed folder look like it was inside.
	 */
	test('`..` разворачивается до сравнения — в обе стороны', () => {
		const sources = ['/w/raw'];
		assert.deepStrictEqual({
			вИсточникЧерезСоседа: isPathAllowed('/w/x/../raw/f.md', sources, true),
			изИсточникаНаружу: isPathAllowed('/w/raw/../docs/f.md', sources, true),
			побегИзРазрешённой: isPathAllowed('/a/proj/../../etc/passwd', ['/a/proj'], true),
			запись_в_папке: normalizeFolderPath('/w/x/../raw/', true),
		}, {
			вИсточникЧерезСоседа: true,
			изИсточникаНаружу: false,
			побегИзРазрешённой: false,
			запись_в_папке: '/w/raw',
		});
	});

	/** `й` as one code point and as `и` + combining breve name the same file. */
	test('составные символы сравниваются в NFC', () => {
		assert.strictEqual(isPathAllowed('/w/\u0438\u0306/f.md', ['/w/\u0439'], true), true);
	});

	test('пустая запись по-прежнему не совпадает ни с чем', () => {
		assert.deepStrictEqual({
			пусто: normalizeFolderPath('', true),
			пробелы: normalizeFolderPath('   ', true),
			корень: isPathAllowed('/any/file', ['/'], true),
		}, { пусто: '', пробелы: '', корень: false });
	});
});

suite('vibeExternalAccess — отозванная папка не спрашивается заново', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('отзыв накрывает папку и всё под ней — иначе агент обойдёт его вложенным путём', () => {
		assert.deepStrictEqual(
			[
				isPathAllowed('/work/secrets', ['/work/secrets'], true),
				isPathAllowed('/work/secrets/keys/id_rsa', ['/work/secrets'], true),
				isPathAllowed('/work/secretsauce/x', ['/work/secrets'], true),
			],
			[true, true, false],
		);
	});

	test('явное разрешение человека снимает отзыв — и на саму папку, и на родителя', () => {
		assert.deepStrictEqual(
			[
				revokedFoldersAfterGrant(['/work/secrets', '/other'], '/work/secrets', true),
				revokedFoldersAfterGrant(['/work/secrets'], '/work', true),
				revokedFoldersAfterGrant(['/work/secrets'], '/elsewhere', true),
			],
			[['/other'], [], ['/work/secrets']],
		);
	});
});

suite('vibeExternalAccess — срок жизни разрешения', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Минимальное окружение сервиса: настройка, модалка и пустая рабочая область. */
	const makeService = (ttlMinutes: number) => {
		const config = { getValue: (key: string) => key === EXTERNAL_ACCESS_TTL_KEY ? ttlMinutes : [], updateValue: async () => { } } as unknown as IConfigurationService;
		const modal = { showModal: async () => ({ buttonId: 'deny' }) } as unknown as IVibeModalService;
		const workspace = { getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService;
		return new VibeExternalAccessService(config, modal, workspace);
	};

	test('разрешение на задачу снимается концом хода, сессионное — нет', async () => {
		const service = makeService(0);
		await service.allowFolder(URI.file('/work/task'), 'run');
		await service.allowFolder(URI.file('/work/session'), 'session');
		const before = service.listAllowed().map(e => `${e.path}:${e.scope}`).sort();
		service.endRunScope();
		const after = service.listAllowed().map(e => `${e.path}:${e.scope}`);
		assert.deepStrictEqual(
			[before, after, service.isAllowed(URI.file('/work/task/file.txt'))],
			[['/work/session:session', '/work/task:run'], ['/work/session:session'], false],
		);
		service.dispose();
	});

	test('истёкшее разрешение перестаёт действовать ровно в свой срок, бессрочное живёт', () => {
		const grants = new Map([
			['/work/expired', { scope: 'session' as const, expiresAt: 1_000 }],
			['/work/exact', { scope: 'session' as const, expiresAt: 2_000 }],
			['/work/later', { scope: 'session' as const, expiresAt: 3_000 }],
			['/work/forever', { scope: 'session' as const }],
		]);
		assert.deepStrictEqual(
			liveGrants(grants, 2_000).sort(),
			['/work/forever', '/work/later'],
		);
	});

	test('сессионное разрешение получает срок из настройки, и он виден в списке отзыва', async () => {
		const service = makeService(30);
		await service.allowFolder(URI.file('/work/ttl'), 'session');
		const granted = service.listAllowed()[0];
		assert.deepStrictEqual(
			[granted.scope, typeof granted.expiresAt, service.isAllowed(URI.file('/work/ttl/file.txt'))],
			['session', 'number', true],
		);
		service.dispose();
	});

	test('разрешение на задачу сроку не подчиняется — оно кончается вместе с ходом, а не по часам', async () => {
		const service = makeService(30);
		await service.allowFolder(URI.file('/work/run'), 'run');
		assert.strictEqual(service.listAllowed()[0].expiresAt, undefined);
		service.dispose();
	});
});
