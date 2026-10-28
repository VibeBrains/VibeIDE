/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type VinylFile from 'vinyl';

/**
 * ELF `e_machine` values for the architectures VS Code packages.
 * See https://refspecs.linuxfoundation.org/elf/gabi4+/ch4.eheader.html.
 */
const elfMachineByArch: Readonly<Record<string, number>> = {
	'ia32': 3,		// EM_386
	'arm': 40,		// EM_ARM
	'armhf': 40,	// EM_ARM
	'x64': 62,		// EM_X86_64
	'arm64': 183,	// EM_AARCH64
};

/**
 * Return the ELF machine type of `contents`, or `undefined` when the buffer is not an ELF file.
 */
export function getElfMachine(contents: Buffer): number | undefined {
	if (contents.length < 20 || contents[0] !== 0x7f || contents.toString('latin1', 1, 4) !== 'ELF') {
		return undefined;
	}

	// `e_ident[EI_DATA]` is 1 for little-endian and 2 for big-endian.
	return contents[5] === 2 ? contents.readUInt16BE(18) : contents.readUInt16LE(18);
}

/**
 * Whether `contents` is an ELF binary built for an architecture other than `arch`.
 * Non-ELF files and unknown architectures are never considered foreign.
 */
export function isForeignElfBinary(contents: Buffer, arch: string): boolean {
	const targetMachine = elfMachineByArch[arch];
	if (targetMachine === undefined) {
		return false;
	}

	const machine = getElfMachine(contents);
	return machine !== undefined && machine !== targetMachine;
}

/**
 * Predicate for `gulp-filter` that drops ELF binaries built for a different architecture.
 *
 * Cross-compiled Linux packages are assembled from `node_modules` installed on the build host.
 * On an x64 host that means `@parcel/watcher`, `node-pty`, the sandbox-runtime `apply-seccomp`
 * helpers and other native payloads are x86_64 even in an arm64 package. Shipping them makes
 * RPM's automatic dependency scanner record `ld-linux-x86-64.so.2`, so the package can never be
 * installed on arm64. Filtering by the ELF header keeps the target binaries (for example
 * `@vscode/os-proxy-resolver-linux-arm64-gnu` and sherpa-onnx arm64) and drops the rest.
 *
 * Only Linux packages can contain ELF files; other targets keep everything untouched.
 */
export function getElfArchExcludeFilter(platform: string, arch: string): (file: VinylFile) => boolean {
	if (platform !== 'linux' && platform !== 'alpine') {
		return () => true;
	}

	return file => {
		if (!Buffer.isBuffer(file.contents)) {
			return true;
		}

		return !isForeignElfBinary(file.contents, arch);
	};
}
