/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import fs from 'fs';
import minimatch from 'minimatch';
import { makeUniversalApp } from 'vscode-universal-bundler';

const root = path.dirname(path.dirname(import.meta.dirname));


async function main(buildDir?: string) {
	const arch = process.env['VSCODE_ARCH'];

	if (!buildDir) {
		throw new Error('Build dir not provided');
	}

	const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
	const appName = product.nameLong + '.app';
	const x64AppPath = path.join(buildDir, 'VibeIDE-darwin-x64', appName);
	const arm64AppPath = path.join(buildDir, 'VibeIDE-darwin-arm64', appName);
	const asarRelativePath = path.join('Contents', 'Resources', 'app', 'node_modules.asar');
	const outAppPath = path.join(buildDir, `VibeIDE-darwin-${arch}`, appName);
	const productJsonPath = path.resolve(outAppPath, 'Contents', 'Resources', 'app', 'product.json');

	// for the host architecture. The universal app merger requires both builds to
	// have identical file trees, so we cross-copy each missing directory from the
	// other build. The binaries are then excluded from comparison (filesToSkip)
	// and the x64 binary is tagged as arch-specific (x64ArchFiles) so the merger
	// keeps both.
	for (const plat of ['darwin-x64', 'darwin-arm64']) {
		for (const base of nodeModulesBases) {
			// @vscode/os-proxy-resolver-{platform} packages
			crossCopyPlatformDir(x64AppPath, arm64AppPath, path.join(base, '@vscode', `os-proxy-resolver-${plat}`));
			// @vscode/ripgrep-universal/bin/{platform} (rg binary)
			crossCopyPlatformDir(x64AppPath, arm64AppPath, path.join(base, '@vscode', 'ripgrep-universal', 'bin', plat));
		}

	}

	for (const base of nodeModulesBases) {
		}
	}

	const filesToSkip = [
		'**/CodeResources',
		'**/Credits.rtf',
		'**/policies/{*.mobileconfig,**/*.plist}',
		'**/node_modules/@vscode/os-proxy-resolver-darwin-x64/**',
		'**/node_modules/@vscode/os-proxy-resolver-darwin-arm64/**',
		'**/node_modules.asar.unpacked/@vscode/os-proxy-resolver-darwin-x64/**',
		'**/node_modules.asar.unpacked/@vscode/os-proxy-resolver-darwin-arm64/**',
		'**/node_modules/@vscode/ripgrep-universal/bin/darwin-x64/**',
		'**/node_modules/@vscode/ripgrep-universal/bin/darwin-arm64/**',
		'**/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-x64/**',
		'**/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-arm64/**',
		// the package includes both arm64 and x64 trees regardless of host arch.
	];

	await makeUniversalApp({
		x64AppPath,
		arm64AppPath,
		asarPath: asarRelativePath,
		outAppPath,
		force: true,
		mergeASARs: true,
		x64ArchFiles: '{*/kerberos.node,**/extensions/microsoft-authentication/dist/libmsalruntime.dylib,**/extensions/microsoft-authentication/dist/msal-node-runtime.node}',
		// Files that are unique to a single arch *inside* the merged `node_modules.asar`.
		// Their on-disk (unpacked) copies are cross-copied between builds above, but the
		// ASAR header still only references the target arch's package, so the merger sees
		// them as arch-unique. Paths here are ASAR-internal (top level, no `node_modules`
		// prefix). Over-covering is harmless: the allowlist is only consulted for files
		// that are actually unique to one arch.
		filesToSkipComparison: (file: string) => {
			for (const expected of filesToSkip) {
				if (minimatch(file, expected)) {
					return true;
				}
			}
			return false;
		}
	});

	const productJson = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
	Object.assign(productJson, {
		darwinUniversalAssetId: 'darwin-universal'
	});
	fs.writeFileSync(productJsonPath, JSON.stringify(productJson, null, '\t'));
}

if (import.meta.main) {
	main(process.argv[2]).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
