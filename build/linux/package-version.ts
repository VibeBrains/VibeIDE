/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import product from '../../product.json' with { type: 'json' };
import packageJson from '../../package.json' with { type: 'json' };

/**
 * Resolves the version baked into Linux packages. VibeIDE carries its own product
 * version in `product.json:vibeVersion`; `package.json:version` is the upstream VS Code
 * base version and must not leak into DEB/RPM metadata or filenames. Unbranded/fork
 * builds without `vibeVersion` keep the upstream behavior.
 */
export function resolveLinuxPackageVersion(vibeVersion: unknown, baseVersion: string): string {
	if (typeof vibeVersion === 'string' && vibeVersion.trim().length > 0) {
		return vibeVersion.trim();
	}

	return baseVersion;
}

/** Version stamped into Linux (.deb/.rpm) packages and their filenames. */
export function getLinuxPackageVersion(): string {
	return resolveLinuxPackageVersion((product as { vibeVersion?: unknown }).vibeVersion, packageJson.version);
}

/** Debian version including the package revision suffix (`<version>-<revision>`). */
export function getLinuxDebPackageVersion(revision: number): string {
	return `${getLinuxPackageVersion()}-${revision}`;
}
