/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	buildInstallerCommand,
	detectInstallerOS,
} from '../../common/installerCommandPicker.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Installer command picker (K.4 / 956)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildInstallerCommand', () => {
		test('win32 → PowerShell call operator + /S', () => {
			const r = buildInstallerCommand({ os: 'win32', installerFilePath: 'C:\\Tmp\\VibeIDE-Setup.exe' });
			assert.strictEqual(r.command, "& 'C:\\Tmp\\VibeIDE-Setup.exe' /S");
			assert.match(r.hint, /silent NSIS/);
		});

		test('win32 doubles embedded single quotes', () => {
			const r = buildInstallerCommand({ os: 'win32', installerFilePath: "C:\\It's\\setup.exe" });
			assert.ok(r.command.includes("It''s"));
			assert.ok(!r.command.includes("It's"));
		});

		test('darwin → sudo installer -pkg target /', () => {
			const r = buildInstallerCommand({ os: 'darwin', installerFilePath: '/tmp/VibeIDE.pkg' });
			assert.strictEqual(r.command, "sudo installer -pkg '/tmp/VibeIDE.pkg' -target /");
		});

		test('linux-deb → sudo dpkg -i', () => {
			const r = buildInstallerCommand({ os: 'linux-deb', installerFilePath: '/tmp/vibeide.deb' });
			assert.strictEqual(r.command, "sudo dpkg -i '/tmp/vibeide.deb'");
		});

		test('linux-rpm → sudo rpm -U', () => {
			const r = buildInstallerCommand({ os: 'linux-rpm', installerFilePath: '/tmp/vibeide.rpm' });
			assert.strictEqual(r.command, "sudo rpm -U '/tmp/vibeide.rpm'");
		});

		test('linux-appimage → chmod + execute', () => {
			const r = buildInstallerCommand({ os: 'linux-appimage', installerFilePath: '/tmp/VibeIDE.AppImage' });
			assert.strictEqual(r.command, "chmod +x '/tmp/VibeIDE.AppImage' && '/tmp/VibeIDE.AppImage'");
		});

		test('POSIX single-quote escape for paths with embedded apostrophe', () => {
			const r = buildInstallerCommand({ os: 'darwin', installerFilePath: "/tmp/it's-here.pkg" });
			// Must contain the POSIX single-quote-escape sequence, not the raw apostrophe inside the quoted string.
			assert.ok(r.command.includes(`'\\''`));
		});

		test('unknown → empty command + open-folder hint', () => {
			const r = buildInstallerCommand({ os: 'unknown', installerFilePath: '/x' });
			assert.strictEqual(r.command, '');
			assert.match(r.hint, /Open the file location/);
		});
	});

	suite('detectInstallerOS', () => {
		test('.exe → win32', () => {
			assert.strictEqual(detectInstallerOS('.exe', 'win32'), 'win32');
		});

		test('.pkg or .dmg → darwin', () => {
			assert.strictEqual(detectInstallerOS('.pkg', 'darwin'), 'darwin');
			assert.strictEqual(detectInstallerOS('.dmg', 'darwin'), 'darwin');
		});

		test('.deb / .rpm / .AppImage', () => {
			assert.strictEqual(detectInstallerOS('.deb', 'linux'), 'linux-deb');
			assert.strictEqual(detectInstallerOS('.rpm', 'linux'), 'linux-rpm');
			assert.strictEqual(detectInstallerOS('.AppImage', 'linux'), 'linux-appimage');
		});

		test('case-insensitive', () => {
			assert.strictEqual(detectInstallerOS('.EXE', 'win32'), 'win32');
			assert.strictEqual(detectInstallerOS('.AppImage', 'linux'), 'linux-appimage');
		});

		test('unknown extension → unknown', () => {
			assert.strictEqual(detectInstallerOS('.tar.gz', 'linux'), 'unknown');
			assert.strictEqual(detectInstallerOS('.zip', 'win32'), 'unknown');
		});
	});
});
