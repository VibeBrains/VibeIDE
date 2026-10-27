/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { suite, test } from 'node:test';
import minimatch from 'minimatch';
import { getSherpaOnnxExcludeFilter, sherpaOnnxPlatforms } from '../sherpaOnnx.ts';

function isIncluded(patterns: string[], file: string): boolean {
	return patterns.every(pattern => minimatch(file, pattern));
}

suite('sherpaOnnx', () => {
	// A stale x64 library in the arm64 package made RPM's find-requires add ld-linux-x86-64.so.2.
	test('linux arm64 keeps arm64 and excludes x64', () => {
		const filter = getSherpaOnnxExcludeFilter('linux', 'arm64');
		assert.ok(isIncluded(filter, 'node_modules/sherpa-onnx-linux-arm64/sherpa-onnx.node'));
		assert.ok(!isIncluded(filter, 'node_modules/sherpa-onnx-linux-x64/sherpa-onnx.node'));
		assert.deepStrictEqual(filter, [
			'**',
			'!**/node_modules/sherpa-onnx-darwin-arm64/**',
			'!**/node_modules/sherpa-onnx-darwin-x64/**',
			'!**/node_modules/sherpa-onnx-linux-x64/**',
			'!**/node_modules/sherpa-onnx-win-ia32/**',
			'!**/node_modules/sherpa-onnx-win-x64/**',
		]);
	});

	test('linux x64 keeps x64 and excludes arm64', () => {
		const filter = getSherpaOnnxExcludeFilter('linux', 'x64');
		assert.ok(isIncluded(filter, 'node_modules/sherpa-onnx-linux-x64/sherpa-onnx.node'));
		assert.ok(!isIncluded(filter, 'node_modules/sherpa-onnx-linux-arm64/sherpa-onnx.node'));
	});

	test('maps build platform/arch names to package names', () => {
		assert.ok(isIncluded(getSherpaOnnxExcludeFilter('win32', 'x64'), 'node_modules/sherpa-onnx-win-x64/sherpa-onnx.node'));
		assert.ok(!isIncluded(getSherpaOnnxExcludeFilter('win32', 'x64'), 'node_modules/sherpa-onnx-win-ia32/sherpa-onnx.node'));
		assert.ok(isIncluded(getSherpaOnnxExcludeFilter('win32', 'ia32'), 'node_modules/sherpa-onnx-win-ia32/sherpa-onnx.node'));
		assert.ok(!isIncluded(getSherpaOnnxExcludeFilter('darwin', 'arm64'), 'node_modules/sherpa-onnx-darwin-x64/sherpa-onnx.node'));
		assert.ok(isIncluded(getSherpaOnnxExcludeFilter('darwin', 'x64'), 'node_modules/sherpa-onnx-darwin-x64/sherpa-onnx.node'));
	});

	test('keeps unrelated files', () => {
		const filter = getSherpaOnnxExcludeFilter('linux', 'arm64');
		assert.ok(isIncluded(filter, 'node_modules/sherpa-onnx-node/sherpa-onnx.js'));
		assert.ok(isIncluded(filter, 'node_modules/typescript/lib/typescript.js'));
	});

	test('excludes every native package for targets without one', () => {
		const filter = getSherpaOnnxExcludeFilter('linux', 'armhf');
		for (const candidate of sherpaOnnxPlatforms) {
			assert.ok(!isIncluded(filter, `node_modules/sherpa-onnx-${candidate}/sherpa-onnx.node`), candidate);
		}
	});

	// Fails when a version bump adds a platform package, which would otherwise silently leak into packages.
	test('accounts for every platform package in the lockfile', () => {
		const lockFilePath = path.join(import.meta.dirname, '..', '..', '..', 'package-lock.json');
		const lockFile = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));
		const lockedPlatforms = Object.keys(lockFile.packages)
			.map(key => /(?:^|\/)node_modules\/sherpa-onnx-(?<platform>(?:darwin|linux|win)-.+)$/.exec(key)?.groups?.platform)
			.filter((platform): platform is string => platform !== undefined)
			.sort();

		assert.deepStrictEqual(lockedPlatforms, [...sherpaOnnxPlatforms].sort());
	});
});
