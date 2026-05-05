/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { IProductConfiguration } from './vs/base/common/product.js';
import type { INodeProcess } from './vs/base/common/platform.js';

const require = createRequire(import.meta.url);

let productObj: Partial<IProductConfiguration> & { BUILD_INSERT_PRODUCT_CONFIGURATION?: string } = { BUILD_INSERT_PRODUCT_CONFIGURATION: 'BUILD_INSERT_PRODUCT_CONFIGURATION' }; // DO NOT MODIFY, PATCHED DURING BUILD
if (productObj['BUILD_INSERT_PRODUCT_CONFIGURATION']) {
	productObj = require('../product.json'); // Running out of sources
}

let pkgObj = { BUILD_INSERT_PACKAGE_CONFIGURATION: 'BUILD_INSERT_PACKAGE_CONFIGURATION' }; // DO NOT MODIFY, PATCHED DURING BUILD
if (pkgObj['BUILD_INSERT_PACKAGE_CONFIGURATION']) {
	pkgObj = require('../package.json'); // Running out of sources
}

// Load sub files
if ((process as INodeProcess).isEmbeddedApp) {
	// Preserve the parent VS Code's policy identity before the
	// embedded app overrides win32RegValueName / darwinBundleIdentifier.
	productObj.parentPolicyConfig = {
		win32RegValueName: productObj.win32RegValueName,
		darwinBundleIdentifier: productObj.darwinBundleIdentifier,
		urlProtocol: productObj.urlProtocol,
	};

	try {
		const productSubObj = require('../product.sub.json');
		if (productObj.embedded && productSubObj.embedded) {
			Object.assign(productObj.embedded, productSubObj.embedded);
			delete productSubObj.embedded;
		}
		Object.assign(productObj, productSubObj);
	} catch (error) { /* ignore */ }
	try {
		const pkgSubObj = require('../package.sub.json');
		pkgObj = Object.assign(pkgObj, pkgSubObj);
	} catch (error) { /* ignore */ }
}

let productOverridesObj = {};
if (process.env['VSCODE_DEV']) {
	try {
		productOverridesObj = require('../product.overrides.json');
		productObj = Object.assign(productObj, productOverridesObj);
	} catch (error) { /* ignore */ }
}

// Stable commit id for dev: NLS/clp cache keys and resolveNLSConfiguration expect
// `product.commit` in retail; without it, upstream nls.ts bails out before language packs.
if (process.env['VSCODE_DEV'] && !productObj.commit) {
	try {
		const repoRoot = join(import.meta.dirname, '..');
		const head = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
		if (head) {
			productObj = Object.assign(productObj, { commit: head });
		}
	} catch {
		// Not a git checkout or git unavailable — resolveNLSConfiguration may still use bundled core.
	}
}

export const product = productObj;
export const pkg = pkgObj;
