/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findNativeModuleFiles, getFilesToAnalyze } from './dependencies-generator.ts';
import product from '../../product.json' with { type: 'json' };

function makeBuildDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'deps-generator-'));
}

function writeNative(buildDir: string, ...segments: string[]): string {
	const file = path.join(buildDir, 'resources', 'app', ...segments);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, 'native');
	return file;
}

suite('getFilesToAnalyze', () => {
	test('accepts a build without the tunnel binary', () => {
		const buildDir = makeBuildDir();
		try {
			const native = writeNative(buildDir, 'node_modules', 'native-keymap', 'build', 'Release', 'keymap.node');
			const files = getFilesToAnalyze(buildDir, 'vibeide');
			const tunnel = path.join(buildDir, 'bin', product.tunnelApplicationName);

			assert.ok(files.includes(native));
			assert.ok(files.includes(path.join(buildDir, 'vibeide')));
			assert.ok(files.includes(path.join(buildDir, 'chrome-sandbox')));
			assert.ok(files.includes(path.join(buildDir, 'chrome_crashpad_handler')));
			assert.ok(!files.includes(tunnel));
		} finally {
			fs.rmSync(buildDir, { recursive: true, force: true });
		}
	});

	test('includes the tunnel binary when it is present', () => {
		const buildDir = makeBuildDir();
		try {
			writeNative(buildDir, 'node_modules', 'native-keymap', 'build', 'Release', 'keymap.node');
			const tunnel = path.join(buildDir, 'bin', product.tunnelApplicationName);
			fs.mkdirSync(path.dirname(tunnel), { recursive: true });
			fs.writeFileSync(tunnel, 'tunnel');

			const files = getFilesToAnalyze(buildDir, 'vibeide');

			assert.ok(files.includes(tunnel));
		} finally {
			fs.rmSync(buildDir, { recursive: true, force: true });
		}
	});
});

suite('findNativeModuleFiles', () => {
	test('upstream layout: node_modules.asar.unpacked wins', () => {
		const buildDir = makeBuildDir();
		try {
			const unpacked = writeNative(buildDir, 'node_modules.asar.unpacked', 'keytar', 'build', 'Release', 'keytar.node');
			writeNative(buildDir, 'node_modules', 'other', 'build', 'Release', 'other.node');
			const files = findNativeModuleFiles(buildDir);
			assert.deepStrictEqual(files, [unpacked]);
		} finally {
			fs.rmSync(buildDir, { recursive: true, force: true });
		}
	});

	test('VibeIDE layout: falls back to real node_modules', () => {
		const buildDir = makeBuildDir();
		try {
			const native = writeNative(buildDir, 'node_modules', 'native-keymap', 'build', 'Release', 'keymap.node');
			const files = findNativeModuleFiles(buildDir);
			assert.deepStrictEqual(files, [native]);
		} finally {
			fs.rmSync(buildDir, { recursive: true, force: true });
		}
	});

	test('empty asar.unpacked falls through to node_modules', () => {
		const buildDir = makeBuildDir();
		try {
			fs.mkdirSync(path.join(buildDir, 'resources', 'app', 'node_modules.asar.unpacked'), { recursive: true });
			const native = writeNative(buildDir, 'node_modules', 'sherpa-onnx', 'sherpa-onnx.node');
			const files = findNativeModuleFiles(buildDir);
			assert.deepStrictEqual(files, [native]);
		} finally {
			fs.rmSync(buildDir, { recursive: true, force: true });
		}
	});

	test('no native .node anywhere throws instead of returning empty', () => {
		const buildDir = makeBuildDir();
		try {
			assert.throws(() => findNativeModuleFiles(buildDir), /No native \.node modules/);
		} finally {
			fs.rmSync(buildDir, { recursive: true, force: true });
		}
	});

	test('existing layout without .node files throws', () => {
		const buildDir = makeBuildDir();
		try {
			fs.mkdirSync(path.join(buildDir, 'resources', 'app', 'node_modules', 'some-package'), { recursive: true });
			fs.writeFileSync(path.join(buildDir, 'resources', 'app', 'node_modules', 'some-package', 'index.js'), 'js');
			assert.throws(() => findNativeModuleFiles(buildDir), /No native \.node modules/);
		} finally {
			fs.rmSync(buildDir, { recursive: true, force: true });
		}
	});
});
