/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, suite, test } from 'node:test';
import { electronExecutableRelPath, installDirectoryAtomically, isExpectedElectronInstalled } from '../electronInstall.ts';

const names = { nameLong: 'Product', nameShort: 'Prod', applicationName: 'prod-app' };

suite('electronInstall', () => {
	let tmp: string;
	let electronDir: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-install-'));
		electronDir = path.join(tmp, 'electron');
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	const writeInstall = (dir: string, version: string, executable: string | undefined) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'version'), version);
		if (executable) {
			fs.mkdirSync(path.dirname(path.join(dir, executable)), { recursive: true });
			fs.writeFileSync(path.join(dir, executable), '');
		}
	};

	test('electronExecutableRelPath follows the names the launch scripts use', () => {
		assert.deepStrictEqual({
			darwin: electronExecutableRelPath('darwin', names),
			win32: electronExecutableRelPath('win32', names),
			linux: electronExecutableRelPath('linux', names),
		}, {
			darwin: path.join('Product.app', 'Contents', 'MacOS', 'Prod'),
			win32: 'Prod.exe',
			linux: 'prod-app',
		});
	});

	test('isExpectedElectronInstalled: only a finished install of the same version counts', async () => {
		const exe = electronExecutableRelPath(process.platform, names);
		writeInstall(path.join(tmp, 'same'), '42.8.0', exe);
		writeInstall(path.join(tmp, 'prefixed'), 'v42.8.0\n', exe);
		writeInstall(path.join(tmp, 'other'), '41.0.0', exe);
		writeInstall(path.join(tmp, 'noExecutable'), '42.8.0', undefined);
		fs.mkdirSync(path.join(tmp, 'shell', path.dirname(exe)), { recursive: true });

		assert.deepStrictEqual({
			same: await isExpectedElectronInstalled(path.join(tmp, 'same'), '42.8.0', exe),
			prefixed: await isExpectedElectronInstalled(path.join(tmp, 'prefixed'), '42.8.0', exe),
			other: await isExpectedElectronInstalled(path.join(tmp, 'other'), '42.8.0', exe),
			noExecutable: await isExpectedElectronInstalled(path.join(tmp, 'noExecutable'), '42.8.0', exe),
			emptyShell: await isExpectedElectronInstalled(path.join(tmp, 'shell'), '42.8.0', exe),
			missing: await isExpectedElectronInstalled(path.join(tmp, 'missing'), '42.8.0', exe),
		}, { same: true, prefixed: true, other: false, noExecutable: false, emptyShell: false, missing: false });
	});

	test('installDirectoryAtomically: a failed download leaves the previous install untouched and no staging folder', async () => {
		writeInstall(electronDir, '41.0.0', 'bin');
		await assert.rejects(
			installDirectoryAtomically(electronDir, async staging => {
				fs.writeFileSync(path.join(staging, 'half'), 'x');
				throw new Error('ConnectTimeoutError');
			}),
			/ConnectTimeoutError/,
		);
		assert.deepStrictEqual({
			version: fs.readFileSync(path.join(electronDir, 'version'), 'utf8'),
			entries: fs.readdirSync(tmp).sort(),
		}, { version: '41.0.0', entries: ['electron'] });
	});

	test('installDirectoryAtomically: a failed first download does not create the folder', async () => {
		await assert.rejects(installDirectoryAtomically(electronDir, async () => { throw new Error('offline'); }), /offline/);
		assert.deepStrictEqual(fs.readdirSync(tmp), []);
	});

	test('installDirectoryAtomically: an empty download is a failure, not an install', async () => {
		writeInstall(electronDir, '41.0.0', undefined);
		await assert.rejects(installDirectoryAtomically(electronDir, async () => { /* nothing downloaded */ }), /no files/);
		assert.deepStrictEqual({ version: fs.readFileSync(path.join(electronDir, 'version'), 'utf8'), entries: fs.readdirSync(tmp) }, { version: '41.0.0', entries: ['electron'] });
	});

	test('installDirectoryAtomically: a finished download replaces the previous install and clears the leftovers', async () => {
		writeInstall(electronDir, '41.0.0', 'old');
		fs.mkdirSync(`${electronDir}.partial`);
		await installDirectoryAtomically(electronDir, async staging => writeInstall(staging, '42.8.0', 'new'));
		assert.deepStrictEqual({
			version: fs.readFileSync(path.join(electronDir, 'version'), 'utf8'),
			files: fs.readdirSync(electronDir).sort(),
			entries: fs.readdirSync(tmp),
		}, { version: '42.8.0', files: ['new', 'version'], entries: ['electron'] });
	});
});
