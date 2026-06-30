/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	composeUnifiedManifest,
	findArtefact,
} from '../../common/releaseManifestUnifier.js';

const sha = (suffix: string = '') => 'a'.repeat(63 - suffix.length) + suffix.padStart(1, 'b');
const sha64 = (c: string = 'a') => c.repeat(64);

const NOW = 1_750_000_000_000;

const validInput = (artefacts: unknown[]) => ({
	vibeVersion: '0.2.0',
	releasedAt: NOW,
	artefacts,
});

suite('Release manifest unifier (N.0)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('composeUnifiedManifest', () => {
		test('happy path with all three platforms', () => {
			const r = composeUnifiedManifest(validInput([
				{ platform: 'win32', arch: 'x64', fileName: 'VibeIDE-Setup-0.2.0.exe', sha256: sha64('a'), sizeBytes: 100 },
				{ platform: 'darwin', arch: 'arm64', fileName: 'VibeIDE-0.2.0-arm64.dmg', sha256: sha64('b'), sizeBytes: 200 },
				{ platform: 'linux', arch: 'x64', fileName: 'vibeide_0.2.0_amd64.deb', sha256: sha64('c'), sizeBytes: 300 },
			]));
			assert.strictEqual(r.skipped.length, 0);
			assert.strictEqual(r.manifest.artefacts.length, 3);
		});

		test('non-array artefacts → skipped index -1', () => {
			const r = composeUnifiedManifest({ vibeVersion: '0.2.0', releasedAt: NOW, artefacts: {} as unknown as unknown[] });
			assert.strictEqual(r.manifest.artefacts.length, 0);
			assert.strictEqual(r.skipped[0].reason, 'artefacts-not-an-array');
		});

		test('rejects unknown platform', () => {
			const r = composeUnifiedManifest(validInput([
				{ platform: 'aix', arch: 'x64', fileName: 'x.tar.gz', sha256: sha64(), sizeBytes: 1 },
			]));
			assert.strictEqual(r.manifest.artefacts.length, 0);
			assert.strictEqual(r.skipped[0].reason, 'platform-invalid');
		});

		test('rejects unknown arch', () => {
			const r = composeUnifiedManifest(validInput([
				{ platform: 'linux', arch: 'mips', fileName: 'x', sha256: sha64(), sizeBytes: 1 },
			]));
			assert.strictEqual(r.skipped[0].reason, 'arch-invalid');
		});

		test('rejects malformed sha256', () => {
			const r = composeUnifiedManifest(validInput([
				{ platform: 'linux', arch: 'x64', fileName: 'x', sha256: 'too-short', sizeBytes: 1 },
			]));
			assert.strictEqual(r.skipped[0].reason, 'sha256-invalid');
		});

		test('rejects negative sizeBytes', () => {
			const r = composeUnifiedManifest(validInput([
				{ platform: 'linux', arch: 'x64', fileName: 'x', sha256: sha64(), sizeBytes: -1 },
			]));
			assert.strictEqual(r.skipped[0].reason, 'sizeBytes-invalid');
		});

		test('lowercases sha256 in output', () => {
			const r = composeUnifiedManifest(validInput([
				{ platform: 'linux', arch: 'x64', fileName: 'x', sha256: 'A'.repeat(64), sizeBytes: 1 },
			]));
			assert.strictEqual(r.manifest.artefacts[0].sha256, 'a'.repeat(64));
		});

		test('orders by platform then arch then fileName', () => {
			const r = composeUnifiedManifest(validInput([
				{ platform: 'win32', arch: 'x64', fileName: 'b.exe', sha256: sha64('a'), sizeBytes: 1 },
				{ platform: 'win32', arch: 'arm64', fileName: 'a.exe', sha256: sha64('b'), sizeBytes: 2 },
				{ platform: 'darwin', arch: 'x64', fileName: 'c.dmg', sha256: sha64('c'), sizeBytes: 3 },
			]));
			assert.deepStrictEqual(
				r.manifest.artefacts.map(a => `${a.platform}-${a.arch}-${a.fileName}`),
				['darwin-x64-c.dmg', 'win32-arm64-a.exe', 'win32-x64-b.exe'],
			);
		});

		test('vibeVersion + releasedAt round-trip', () => {
			const r = composeUnifiedManifest(validInput([]));
			assert.strictEqual(r.manifest.vibeVersion, '0.2.0');
			assert.strictEqual(r.manifest.releasedAt, NOW);
		});

		test('multiple skipped entries collected with their index', () => {
			const r = composeUnifiedManifest(validInput([
				{ platform: 'win32', arch: 'x64', fileName: 'x', sha256: 'short', sizeBytes: 1 },
				{ platform: 'linux', arch: 'x64', fileName: 'y', sha256: sha64(), sizeBytes: -1 },
				{ platform: 'darwin', arch: 'x64', fileName: 'z', sha256: sha64(), sizeBytes: 1 },
			]));
			assert.strictEqual(r.skipped.length, 2);
			assert.strictEqual(r.skipped[0].index, 0);
			assert.strictEqual(r.skipped[1].index, 1);
			assert.strictEqual(r.manifest.artefacts.length, 1);
		});

		// Reference the unused `sha` helper to keep TS happy.
		test('sha helper exists', () => {
			assert.ok(typeof sha() === 'string');
		});
	});

	suite('findArtefact', () => {
		const r = composeUnifiedManifest(validInput([
			{ platform: 'win32', arch: 'x64', fileName: 'win.exe', sha256: sha64('1'), sizeBytes: 1 },
			{ platform: 'darwin', arch: 'arm64', fileName: 'mac.dmg', sha256: sha64('2'), sizeBytes: 2 },
		]));

		test('finds matching artefact', () => {
			const a = findArtefact(r.manifest, 'win32', 'x64');
			assert.ok(a);
			assert.strictEqual(a!.fileName, 'win.exe');
		});

		test('returns undefined on miss', () => {
			assert.strictEqual(findArtefact(r.manifest, 'linux', 'x64'), undefined);
		});
	});
});
