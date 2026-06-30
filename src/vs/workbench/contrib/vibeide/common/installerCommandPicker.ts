/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure helper: pick the right "copy to clipboard" install command for the
 * silent-installer fallback UX (K.4 / 956).
 *
 * Until the silent-helper process ships, the user gets the installer file
 * by clicking through the open-folder UI. A better stop-gap: copy the
 * exact CLI for the user's OS into the clipboard so they paste it into a
 * terminal. This module returns the command string + a one-line hint;
 * the runtime calls clipboard.writeText() and shows the toast.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type InstallerOS = 'win32' | 'darwin' | 'linux-deb' | 'linux-rpm' | 'linux-appimage' | 'unknown';

export interface InstallerInput {
	os: InstallerOS;
	installerFilePath: string;
}

export interface InstallerCommand {
	command: string;
	hint: string;
}

/**
 * Build a clipboard-ready install command. Pure.
 *
 * - Windows: `& '<path>' /S` — silent NSIS install with the silent flag.
 * - macOS: `installer -pkg '<path>' -target /` — Apple's pkg installer
 *   (requires sudo; hint mentions it).
 * - Linux .deb: `sudo dpkg -i '<path>'`
 * - Linux .rpm: `sudo rpm -U '<path>'`
 * - Linux AppImage: `chmod +x '<path>' && '<path>'`
 * - unknown: returns a "open folder" suggestion the runtime treats as the
 *   pre-existing fallback rather than a clipboard hint.
 *
 * Quoting: the path is wrapped in single quotes; an embedded single quote
 * is escaped per shell (POSIX uses `'\''`, PowerShell uses `''`). This is
 * the only meaningful sanitisation — we do NOT support paths with newlines
 * or control characters; the wrapper should reject those upstream.
 */
export function buildInstallerCommand(input: InstallerInput): InstallerCommand {
	const path = input.installerFilePath;
	switch (input.os) {
		case 'win32':
			return {
				command: `& '${escapePowerShell(path)}' /S`,
				hint: 'PowerShell: silent NSIS install. Confirm UAC if prompted.',
			};
		case 'darwin':
			return {
				command: `sudo installer -pkg '${escapePosix(path)}' -target /`,
				hint: 'Bash/zsh: requires sudo password. Targets the system volume.',
			};
		case 'linux-deb':
			return {
				command: `sudo dpkg -i '${escapePosix(path)}'`,
				hint: 'Bash: Debian/Ubuntu .deb install (run apt-get install -f if deps fail).',
			};
		case 'linux-rpm':
			return {
				command: `sudo rpm -U '${escapePosix(path)}'`,
				hint: 'Bash: Fedora/RHEL .rpm upgrade-or-install.',
			};
		case 'linux-appimage':
			return {
				command: `chmod +x '${escapePosix(path)}' && '${escapePosix(path)}'`,
				hint: 'Bash: AppImage — chmod, then run. No global install; user keeps the file.',
			};
		case 'unknown':
		default:
			return {
				command: '',
				hint: 'Open the file location and run the installer manually.',
			};
	}
}

function escapePosix(s: string): string {
	// In a POSIX single-quoted string, a literal single quote is `'\''`.
	return s.replace(/'/g, `'\\''`);
}

function escapePowerShell(s: string): string {
	// In a PowerShell single-quoted string, a literal single quote is doubled.
	return s.replace(/'/g, `''`);
}

/**
 * Detect the runtime OS bucket from `process.platform` + a precomputed
 * file-extension hint. Pure-ish — takes raw inputs, returns the bucket.
 *
 *   ext = '.exe'              ⇒ 'win32'
 *   ext = '.pkg' / '.dmg'     ⇒ 'darwin'
 *   ext = '.deb'              ⇒ 'linux-deb'
 *   ext = '.rpm'              ⇒ 'linux-rpm'
 *   ext = '.AppImage'         ⇒ 'linux-appimage'
 *   anything else             ⇒ 'unknown'
 */
export function detectInstallerOS(extension: string, platform: string): InstallerOS {
	const ext = extension.toLowerCase();
	if (ext === '.exe' || (platform === 'win32' && ext === '')) { return 'win32'; }
	if (ext === '.pkg' || ext === '.dmg' || (platform === 'darwin' && ext === '')) { return 'darwin'; }
	if (ext === '.deb') { return 'linux-deb'; }
	if (ext === '.rpm') { return 'linux-rpm'; }
	if (ext === '.appimage') { return 'linux-appimage'; }
	return 'unknown';
}
