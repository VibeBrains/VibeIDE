/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IMountEntry {
	readonly mountPoint: string;
	readonly local: boolean;
}

/**
 * Parses the output of macOS `mount` (see mount(8)). Only the mount point and
 * the `local` option are needed: local volumes are mounted by the kernel from
 * a block device, network shares (smbfs, nfs, afpfs) are not.
 */
export function parseMountTable(output: string): IMountEntry[] {
	const entries: IMountEntry[] = [];

	for (const line of output.split(/\r?\n/)) {
		const match = /^.+? on (.+) \(([^()]*)\)$/.exec(line);
		if (!match) {
			continue;
		}

		const mountPoint = match[1];
		const options = match[2].split(',').map(option => option.trim());

		entries.push({ mountPoint, local: options.includes('local') });
	}

	return entries;
}

function normalizePath(path: string): string {
	// macOS volumes are usually case-insensitive, matching the previous
	// isEqualOrParent(..., ignoreCase = true) behaviour.
	return (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path).toLowerCase();
}

/**
 * Finds the mount entry covering `path`, preferring the longest (most
 * specific) mount point. Returns `undefined` when the path is not in the
 * table, so callers can stay conservative and refuse to watch it.
 */
export function findMountEntry(path: string, entries: readonly IMountEntry[]): IMountEntry | undefined {
	const normalizedPath = normalizePath(path);
	let best: IMountEntry | undefined;
	let bestLength = -1;

	for (const entry of entries) {
		const normalizedMountPoint = normalizePath(entry.mountPoint);
		const covers = normalizedMountPoint === '/'
			|| normalizedPath === normalizedMountPoint
			|| normalizedPath.startsWith(normalizedMountPoint + '/');

		if (covers && normalizedMountPoint.length > bestLength) {
			best = entry;
			bestLength = normalizedMountPoint.length;
		}
	}

	return best;
}

/**
 * Whether `path` belongs to a locally mounted volume according to the macOS
 * mount table. Unknown paths, paths that only fall back to the root mount and
 * network shares report `false`: we only want to trust an explicit volume
 * entry, otherwise refusing to watch stays the safe default.
 */
export function isLocalVolume(path: string, entries: readonly IMountEntry[]): boolean {
	const entry = findMountEntry(path, entries);
	if (!entry || normalizePath(entry.mountPoint) === '/') {
		return false;
	}

	return entry.local;
}