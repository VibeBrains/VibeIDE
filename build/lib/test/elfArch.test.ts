/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import type { FileFunction } from 'gulp-filter';
import type VinylFile from 'vinyl';
import { getElfArchExcludeFilter, getElfMachine, isForeignElfBinary } from '../elfArch.ts';

function elf(machine: number, littleEndian = true): Buffer {
	const contents = Buffer.alloc(20);
	contents.write('\x7fELF', 0, 'latin1');
	contents[4] = 2; // ELFCLASS64
	contents[5] = littleEndian ? 1 : 2; // ELFDATA2LSB / ELFDATA2MSB
	if (littleEndian) {
		contents.writeUInt16LE(machine, 18);
	} else {
		contents.writeUInt16BE(machine, 18);
	}
	return contents;
}

function file(contents: Buffer, relative = 'node_modules/example/binary.node'): VinylFile {
	return { contents, relative } as VinylFile;
}

const X86_64 = 62;
const AARCH64 = 183;

suite('elfArch', () => {
	test('parses the ELF machine type', () => {
		assert.strictEqual(getElfMachine(elf(X86_64)), X86_64);
		assert.strictEqual(getElfMachine(elf(AARCH64)), AARCH64);
		assert.strictEqual(getElfMachine(elf(AARCH64, false)), AARCH64);
	});

	test('ignores non-ELF and short buffers', () => {
		assert.strictEqual(getElfMachine(Buffer.from('module.exports = 1')), undefined);
		assert.strictEqual(getElfMachine(Buffer.alloc(0)), undefined);
		assert.strictEqual(getElfMachine(elf(X86_64).subarray(0, 12)), undefined);
	});

	test('detects binaries of a foreign architecture', () => {
		assert.strictEqual(isForeignElfBinary(elf(X86_64), 'arm64'), true);
		assert.strictEqual(isForeignElfBinary(elf(AARCH64), 'arm64'), false);
		assert.strictEqual(isForeignElfBinary(elf(AARCH64), 'x64'), true);
		assert.strictEqual(isForeignElfBinary(elf(X86_64), 'x64'), false);
		assert.strictEqual(isForeignElfBinary(Buffer.from('not an ELF'), 'arm64'), false);
	});

	test('linux arm64 keeps arm64 and non-ELF files, drops x86_64 ELF files', () => {
		const filter = getElfArchExcludeFilter('linux', 'arm64');

		// Native payloads that must stay in the arm64 package.
		assert.strictEqual(filter(file(elf(AARCH64), 'node_modules/@vscode/os-proxy-resolver-linux-arm64-gnu/os_proxy_resolver.node')), true);
		assert.strictEqual(filter(file(elf(AARCH64), 'node_modules/sherpa-onnx-linux-arm64/sherpa-onnx.node')), true);
		assert.strictEqual(filter(file(elf(AARCH64), 'node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp')), true);
		assert.strictEqual(filter(file(Buffer.from('export const x = 1;'), 'node_modules/typescript/lib/typescript.js')), true);

		// Reproduces the CI leak: host-installed x86_64 native payloads.
		assert.strictEqual(filter(file(elf(X86_64), 'node_modules/@parcel/watcher/build/Release/watcher.node')), false);
		assert.strictEqual(filter(file(elf(X86_64), 'node_modules/node-pty/build/Release/pty.node')), false);
		assert.strictEqual(filter(file(elf(X86_64), 'node_modules/@vscode/sandbox-runtime/vendor/seccomp/x64/apply-seccomp')), false);
	});

	test('linux x64 keeps x64 and drops arm64', () => {
		const filter = getElfArchExcludeFilter('linux', 'x64');
		assert.strictEqual(filter(file(elf(X86_64))), true);
		assert.strictEqual(filter(file(elf(AARCH64))), false);
	});

	test('does not touch non-Linux packages', () => {
		for (const platform of ['darwin', 'win32']) {
			const filter = getElfArchExcludeFilter(platform, 'arm64');
			assert.strictEqual(filter(file(elf(X86_64))), true, platform);
		}
	});

	test('is a valid gulp-filter predicate', () => {
		const predicate: FileFunction = getElfArchExcludeFilter('linux', 'arm64');
		assert.strictEqual(predicate(file(elf(X86_64))), false);
		assert.strictEqual(predicate(file(elf(AARCH64))), true);
	});
});
