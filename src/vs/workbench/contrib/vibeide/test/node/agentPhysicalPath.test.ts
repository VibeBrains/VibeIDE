/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises } from 'fs';
import { tmpdir } from 'os';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { Promises } from '../../../../../base/node/pfs.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getRandomTestPath } from '../../../../../base/test/node/testUtils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { PhysicalPath, PhysicalPathProbe, resolvePhysicalEntry, resolvePhysicalPath } from '../../common/agentPhysicalPath.js';

/**
 * Физический слой на настоящем диске, через продуктовый IFileService.
 *
 * The fake filesystem in test/common proves the logic; this proves what the logic rests on, which
 * was read off the source rather than run: `exists` answers yes for a dangling link while `realpath`
 * throws on it, and `realpath` of a missing path throws rather than returning undefined. Symlinks
 * are POSIX here — on Windows creating one needs privileges the test runner does not have.
 */
(isWindows ? suite.skip : suite)('физический путь агента — настоящий диск', () => {
	const disposables = new DisposableStore();
	let testDir: string;
	let probe: PhysicalPathProbe;
	/** Expected paths are resolved too: the temp folder itself sits under a link on macOS (`/var`). */
	let real: (relative: string) => string;

	setup(async () => {
		testDir = getRandomTestPath(tmpdir(), 'vsctests', 'agentphysicalpath');
		await promises.mkdir(join(testDir, 'ws', 'src'), { recursive: true });
		await promises.mkdir(join(testDir, 'outside'), { recursive: true });
		await promises.writeFile(join(testDir, 'outside', 'secret.txt'), 'secret');
		await promises.symlink(join(testDir, 'outside'), join(testDir, 'ws', 'link'));
		await promises.symlink(join(testDir, 'nowhere'), join(testDir, 'ws', 'dangling'));

		const logService = new NullLogService();
		const fileService = disposables.add(new FileService(logService));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new DiskFileSystemProvider(logService))));
		probe = { exists: u => fileService.exists(u), realpath: u => fileService.realpath(u) };

		const base = await promises.realpath(testDir);
		real = relative => join(base, relative);
	});

	teardown(() => {
		disposables.clear();
		return Promises.rm(testDir);
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	const at = (relative: string) => URI.file(join(testDir, relative));
	const show = (p: PhysicalPath) => p.kind === 'resolved' ? p.uri.fsPath : p.kind;

	test('ссылка наружу, висячая ссылка и удаление самой ссылки', async () => {
		assert.deepStrictEqual({
			черезСсылку: show(await resolvePhysicalPath(at('ws/link/secret.txt'), probe)),
			новыйЧерезСсылку: show(await resolvePhysicalPath(at('ws/link/new.txt'), probe)),
			висячая: show(await resolvePhysicalPath(at('ws/dangling'), probe)),
			подВисячей: show(await resolvePhysicalPath(at('ws/dangling/x.txt'), probe)),
			обычныйНовый: show(await resolvePhysicalPath(at('ws/src/new.ts'), probe)),
			удалениеСсылки: show(await resolvePhysicalEntry(at('ws/link'), probe)),
		}, {
			черезСсылку: real('outside/secret.txt'),
			новыйЧерезСсылку: real('outside/new.txt'),
			висячая: 'unresolvable',
			подВисячей: 'unresolvable',
			обычныйНовый: real('ws/src/new.ts'),
			удалениеСсылки: real('ws/link'),
		});
	});
});
