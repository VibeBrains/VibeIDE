/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import product from '../../product.json' with { type: 'json' };
import packageJson from '../../package.json' with { type: 'json' };
import { getLinuxDebPackageVersion, getLinuxPackageVersion, resolveLinuxPackageVersion } from './package-version.ts';

suite('linux package version', () => {
	test('uses product.vibeVersion instead of the package.json base version', () => {
		// Regression: release assets were named vibeide_1.133.0-..._amd64.deb because
		// the VS Code base version leaked into DEB/RPM metadata and filenames.
		assert.strictEqual(resolveLinuxPackageVersion('1.29.0', '1.133.0'), '1.29.0');
	});

	test('falls back to the base version when vibeVersion is absent', () => {
		assert.strictEqual(resolveLinuxPackageVersion(undefined, '1.133.0'), '1.133.0');
		assert.strictEqual(resolveLinuxPackageVersion('', '1.133.0'), '1.133.0');
		assert.strictEqual(resolveLinuxPackageVersion('   ', '1.133.0'), '1.133.0');
		assert.strictEqual(resolveLinuxPackageVersion(42, '1.133.0'), '1.133.0');
	});

	test('repository metadata resolves to the VibeIDE product version', () => {
		assert.strictEqual(getLinuxPackageVersion(), product.vibeVersion);
		assert.notStrictEqual(getLinuxPackageVersion(), packageJson.version);
	});

	test('deb version carries the package revision suffix', () => {
		assert.strictEqual(getLinuxDebPackageVersion(1700000000), `${product.vibeVersion}-1700000000`);
	});
});
