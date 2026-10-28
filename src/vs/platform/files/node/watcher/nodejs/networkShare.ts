/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { isMacintosh } from '../../../../../base/common/platform.js';

/**
 * `statfs(2).f_type` values for network filesystems on macOS, as assigned in xnu's
 * `vfs_conf.c`. Node's `fs.statfs()` exposes only this numeric type: `f_fstypename`
 * and `MNT_LOCAL` are not part of the Node API.
 */
const macNetworkFileSystemTypes: ReadonlySet<number> = new Set([
	18, // smbfs
	20, // nfs
	21, // webdav
]);

export function isNetworkFileSystemType(type: number): boolean {
	return macNetworkFileSystemTypes.has(type);
}

/**
 * Checks the filesystem the path actually lives on instead of guessing from its prefix.
 * Local volumes are mounted under `/Volumes` on macOS too (for example an external APFS
 * disk), so a `/Volumes` prefix alone does not mean a network share.
 */
export async function isNetworkShare(path: string): Promise<boolean> {
	if (!isMacintosh) {
		return false;
	}
	try {
		const stats = await fs.statfs(path);
		return isNetworkFileSystemType(Number(stats.type));
	} catch {
		// If the filesystem cannot be inspected, do not refuse to watch: a false
		// positive disables file watching for local projects.
		return false;
	}
}
