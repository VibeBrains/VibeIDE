/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import { promises as fs } from 'fs';

/**
 * The state of `.build/electron`: is the Electron we need already there, and how to put a new one in place
 * No third-party imports: `preLaunch.ts` loads this before `npm ci` has run
 */

/** The names of the product that decide how the Electron executable is called, from `product.json` */
export interface ElectronProductNames {
	readonly nameLong: string;
	readonly nameShort: string;
	readonly applicationName: string;
}

/**
 * The executable inside the Electron folder, relative to it
 * The names are the ones `scripts/test.sh`, `scripts/test.bat` and `scripts/code.sh` launch
 */
export function electronExecutableRelPath(platform: NodeJS.Platform, names: ElectronProductNames): string {
	switch (platform) {
		case 'darwin':
			return path.join(`${names.nameLong}.app`, 'Contents', 'MacOS', names.nameShort);
		case 'win32':
			return `${names.nameShort}.exe`;
		default:
			return names.applicationName;
	}
}

/**
 * Whether `electronDir` holds a finished install of `expectedVersion`
 * The `version` file comes with the Electron archive and the executable is what the launch scripts run:
 * a folder that has only one of them is a leftover of an interrupted download, not an install
 */
export async function isExpectedElectronInstalled(electronDir: string, expectedVersion: string, executableRelPath: string): Promise<boolean> {
	try {
		const installed = (await fs.readFile(path.join(electronDir, 'version'), 'utf8')).trim().replace(/^v/, '');
		if (installed !== expectedVersion.replace(/^v/, '')) {
			return false;
		}
		return (await fs.stat(path.join(electronDir, executableRelPath))).isFile();
	} catch {
		return false;
	}
}

const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;

/**
 * Fills `targetDir` through a staging folder next to it, so the folder is never half-written
 * `build` gets the staging folder and must put the whole install there
 * Only a finished staging folder replaces `targetDir`; if `build` throws, `targetDir` is left exactly as it was
 * The old install is parked beside the new one for the swap and put back if the swap fails
 */
export async function installDirectoryAtomically(targetDir: string, build: (stagingDir: string) => Promise<void>): Promise<void> {
	const stagingDir = `${targetDir}.partial`;
	const parkedDir = `${targetDir}.old`;
	await fs.rm(stagingDir, REMOVE_OPTIONS);
	await fs.rm(parkedDir, REMOVE_OPTIONS);
	await fs.mkdir(path.dirname(targetDir), { recursive: true });
	try {
		await fs.mkdir(stagingDir);
		await build(stagingDir);
		if ((await fs.readdir(stagingDir)).length === 0) {
			throw new Error('the download produced no files');
		}
	} catch (err) {
		await fs.rm(stagingDir, REMOVE_OPTIONS);
		throw err;
	}

	const hadPrevious = await fs.stat(targetDir).then(() => true, () => false);
	if (hadPrevious) {
		await fs.rename(targetDir, parkedDir);
	}
	try {
		await fs.rename(stagingDir, targetDir);
	} catch (err) {
		if (hadPrevious) {
			await fs.rename(parkedDir, targetDir);
		}
		await fs.rm(stagingDir, REMOVE_OPTIONS);
		throw err;
	}
	await fs.rm(parkedDir, REMOVE_OPTIONS);
}
