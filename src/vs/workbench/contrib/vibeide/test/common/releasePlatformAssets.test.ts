/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	hasReleaseAssetForPlatform,
	isBuildUpToDateVersusTag,
	pickNewestRelease,
	pickNewestReleaseForPlatform,
	ReleaseCandidate,
} from '../../common/releasePlatformAssets.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const STABLE = { allowPrerelease: false } as const;
const PRE = { allowPrerelease: true } as const;

/** Real asset naming from our releases. */
const macAssets = ['VibeIDE-1.9.1-darwin-arm64.dmg', 'VibeIDE-1.9.1-darwin-arm64.zip'];
const crossAssets = ['VibeIDE-1.9.0-darwin-arm64.dmg', 'VibeIDE-1.9.0-darwin-arm64.zip', 'VibeIDE-1.9.0-win32-x64.zip', 'VibeIDESetup.exe'];

function release(tagName: string, assetNames: readonly string[], extra?: Partial<ReleaseCandidate>): ReleaseCandidate {
	return { tagName, assetNames, ...extra };
}

suite('Release platform assets — platform-aware update selection', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('hasReleaseAssetForPlatform', () => {
		test('mac-only release carries a build for darwin-arm64 but not for windows', () => {
			assert.deepStrictEqual(
				{
					darwinArm: hasReleaseAssetForPlatform(macAssets, 'darwin', 'arm64'),
					win64: hasReleaseAssetForPlatform(macAssets, 'win32', 'x64'),
					linux: hasReleaseAssetForPlatform(macAssets, 'linux', 'x64'),
				},
				{ darwinArm: true, win64: false, linux: false },
			);
		});

		test('cross-platform release covers windows and mac; arch-less installer counts on ARM windows', () => {
			assert.deepStrictEqual(
				{
					win64: hasReleaseAssetForPlatform(crossAssets, 'win32', 'x64'),
					winArm: hasReleaseAssetForPlatform(crossAssets, 'win32', 'arm64'),
					darwinArm: hasReleaseAssetForPlatform(crossAssets, 'darwin', 'arm64'),
					darwinIntel: hasReleaseAssetForPlatform(crossAssets, 'darwin', 'x64'),
				},
				{ win64: true, winArm: true, darwinArm: true, darwinIntel: false },
			);
		});

		test('checksum and manifest side-files are not installable builds', () => {
			assert.strictEqual(hasReleaseAssetForPlatform(['release-manifest.json', 'checksums-sha256.txt'], 'win32', 'x64'), false);
		});

		test('universal artifacts satisfy any arch', () => {
			assert.strictEqual(hasReleaseAssetForPlatform(['VibeIDE-2.0.0-darwin-universal.zip'], 'darwin', 'x64'), true);
		});
	});

	suite('pickNewestReleaseForPlatform', () => {
		const catalogue = [
			release('v1.9.1', macAssets),      // mac-only patch
			release('v1.9.0', crossAssets),
			release('v1.8.0', crossAssets),
		];

		test('windows skips the mac-only newest tag and lands on the newest windows build', () => {
			const picked = pickNewestReleaseForPlatform(catalogue, 'win32', 'x64', STABLE);
			assert.strictEqual(picked?.tagName, 'v1.9.0');
		});

		test('mac gets the newest tag', () => {
			const picked = pickNewestReleaseForPlatform(catalogue, 'darwin', 'arm64', STABLE);
			assert.strictEqual(picked?.tagName, 'v1.9.1');
		});

		test('ordering is by semver, not by list order', () => {
			const shuffled = [release('v1.8.0', crossAssets), release('v1.10.0', crossAssets), release('v1.9.0', crossAssets)];
			assert.strictEqual(pickNewestReleaseForPlatform(shuffled, 'win32', 'x64', STABLE)?.tagName, 'v1.10.0');
		});

		test('drafts are never offered; pre-releases only on non-stable channels', () => {
			const withSpecials = [
				release('v2.0.0', crossAssets, { draft: true }),
				release('v1.9.5', crossAssets, { prerelease: true }),
				release('v1.9.0', crossAssets),
			];
			assert.deepStrictEqual(
				{
					stable: pickNewestReleaseForPlatform(withSpecials, 'win32', 'x64', STABLE)?.tagName,
					beta: pickNewestReleaseForPlatform(withSpecials, 'win32', 'x64', PRE)?.tagName,
				},
				{ stable: 'v1.9.0', beta: 'v1.9.5' },
			);
		});

		test('a release reporting no assets stays a candidate — unknown must not hide a real update', () => {
			const picked = pickNewestReleaseForPlatform([release('v1.9.2', [])], 'win32', 'x64', STABLE);
			assert.strictEqual(picked?.tagName, 'v1.9.2');
		});

		test('null when nothing carries a build for the platform', () => {
			assert.strictEqual(pickNewestReleaseForPlatform([release('v1.9.1', macAssets)], 'linux', 'x64', STABLE), null);
		});

		test('unparseable tags are skipped, not guessed at', () => {
			const picked = pickNewestReleaseForPlatform([release('nightly-latest', crossAssets), release('v1.9.0', crossAssets)], 'win32', 'x64', STABLE);
			assert.strictEqual(picked?.tagName, 'v1.9.0');
		});
	});

	suite('pickNewestRelease (platform-agnostic)', () => {
		test('sees the mac-only release that the windows-scoped pick skipped', () => {
			const catalogue = [release('v1.9.1', macAssets), release('v1.9.0', crossAssets)];
			assert.deepStrictEqual(
				{
					overall: pickNewestRelease(catalogue, STABLE)?.tagName,
					forWindows: pickNewestReleaseForPlatform(catalogue, 'win32', 'x64', STABLE)?.tagName,
				},
				{ overall: 'v1.9.1', forWindows: 'v1.9.0' },
			);
		});
	});

	suite('isBuildUpToDateVersusTag', () => {
		test('compares running build against a tag, tolerating the v-prefix', () => {
			assert.deepStrictEqual(
				{
					older: isBuildUpToDateVersusTag('1.8.0', 'v1.9.0'),
					same: isBuildUpToDateVersusTag('1.9.0', 'v1.9.0'),
					newer: isBuildUpToDateVersusTag('1.9.1', 'v1.9.0'),
					unparseableRemote: isBuildUpToDateVersusTag('1.9.0', 'not-a-version'),
				},
				{ older: false, same: true, newer: true, unparseableRemote: true },
			);
		});
	});
});
