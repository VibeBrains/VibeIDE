/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Platform-aware release selection for the GitHub-tag update path (pure helpers).
 *
 * Why this exists: releases are not always cross-platform. A macOS-only patch (e.g. v1.9.1,
 * which fixed voice input on macOS) publishes only darwin artifacts. Comparing the running
 * build against the newest *tag* then produces two defects at once:
 *
 *   1. false nag — a Windows user is told "update available" for a release that has no
 *      Windows build at all;
 *   2. missed update — that same user is never offered the newest release that *does* have
 *      a Windows build (they sit on 1.8.0 while 1.9.0 ships a Windows installer).
 *
 * Both disappear once the update check asks "what is the newest release carrying a build for
 * MY platform?" instead of "what is the newest tag?".
 *
 * Pure — no I/O, no `electron`, no platform detection. The caller passes the release list it
 * fetched and the platform/arch it detected, which keeps the rules unit-testable.
 */

import * as semver from '../../../../base/common/semver/semver.js';

export type ReleasePlatform = 'win32' | 'darwin' | 'linux';
export type ReleaseArch = 'x64' | 'arm64';

/** Minimal shape of a GitHub release needed to pick one. */
export interface ReleaseCandidate {
	readonly tagName: string;
	readonly assetNames: readonly string[];
	readonly draft?: boolean;
	readonly prerelease?: boolean;
}

export interface PickReleaseOptions {
	/** Beta/nightly channels accept pre-releases; stable does not. */
	readonly allowPrerelease: boolean;
}

/**
 * Assets that ship alongside the installers but are not themselves installable. Without this
 * filter a release carrying only checksums would look like a valid build for every platform.
 */
const NON_ARTIFACT_PATTERN = /(^release-manifest\.json$|^checksums.*\.txt$|\.sha256$|\.asc$|\.sig$)/i;

/** GitHub release tag or product version → comparable semver string, or null when unparseable. */
export function normalizeSemverVersion(raw: string | undefined): string | null {
	if (!raw) {
		return null;
	}
	const trimmed = raw.trim();
	const withoutV = /^v\d/i.test(trimmed) ? trimmed.slice(1) : trimmed;
	const coerced = semver.coerce(withoutV) ?? semver.coerce(trimmed);
	return coerced ? semver.valid(coerced) : null;
}

/**
 * Does this asset name look like an installable build for the given platform/arch?
 *
 * Naming convention of our release artifacts:
 *   macOS   — `VibeIDE-<ver>-darwin-arm64.dmg` / `.zip`
 *   Windows — `VibeIDE-<ver>-win32-x64.zip` and the installer `VibeIDESetup.exe`
 *   Linux   — `VibeIDE-<ver>-linux-<arch>.{deb,rpm,AppImage,tar.gz}`
 *
 * The Windows installer carries no arch token; it is an x64 build, which Windows-on-ARM runs
 * under emulation, so it counts for both Windows arches. `universal` counts for any arch.
 */
function isAssetForPlatform(assetName: string, platform: ReleasePlatform, arch: ReleaseArch): boolean {
	if (NON_ARTIFACT_PATTERN.test(assetName)) {
		return false;
	}
	const name = assetName.toLowerCase();

	if (platform === 'win32') {
		// Arch-less `.exe` installer counts for every Windows arch (x64 runs on ARM via emulation).
		return name.endsWith('.exe') || name.includes(`win32-${arch}`) || name.includes('win32-universal');
	}
	if (platform === 'darwin') {
		return name.includes(`darwin-${arch}`) || name.includes('darwin-universal');
	}
	return name.includes(`linux-${arch}`) || name.includes('linux-universal');
}

/** True when the release carries at least one installable build for the given platform/arch. */
export function hasReleaseAssetForPlatform(assetNames: readonly string[], platform: ReleasePlatform, arch: ReleaseArch): boolean {
	if (!Array.isArray(assetNames)) {
		return false;
	}
	return assetNames.some(n => typeof n === 'string' && isAssetForPlatform(n, platform, arch));
}

/**
 * Newest release that actually carries a build for this platform, or null when none of the
 * supplied releases does.
 *
 * Ordering is decided by semver, not by the order GitHub returned — a release whose tag cannot
 * be parsed is skipped rather than guessed at. Drafts are always excluded; pre-releases only
 * when the channel allows them.
 *
 * Note the deliberate asymmetry with `hasReleaseAssetForPlatform`: a release that reports **no
 * assets at all** is treated as a candidate here. An empty asset list means "the API told us
 * nothing", not "there is no build", and suppressing a real update is worse than one stale nag.
 */
export function pickNewestReleaseForPlatform(
	releases: readonly ReleaseCandidate[],
	platform: ReleasePlatform,
	arch: ReleaseArch,
	options: PickReleaseOptions,
): ReleaseCandidate | null {
	return pickNewest(releases, options, release => {
		const assets = Array.isArray(release.assetNames) ? release.assetNames : [];
		return assets.length === 0 || hasReleaseAssetForPlatform(assets, platform, arch);
	});
}

/**
 * Newest release regardless of platform. Used to tell "you are on the newest build" apart from
 * "a newer build exists, but not for your OS" — the two need different wording.
 */
export function pickNewestRelease(releases: readonly ReleaseCandidate[], options: PickReleaseOptions): ReleaseCandidate | null {
	return pickNewest(releases, options, () => true);
}

function pickNewest(
	releases: readonly ReleaseCandidate[],
	options: PickReleaseOptions,
	accept: (release: ReleaseCandidate) => boolean,
): ReleaseCandidate | null {
	if (!Array.isArray(releases)) {
		return null;
	}

	let best: ReleaseCandidate | null = null;
	let bestVersion: string | null = null;

	for (const release of releases) {
		if (!release || typeof release.tagName !== 'string') {
			continue;
		}
		if (release.draft === true) {
			continue;
		}
		if (release.prerelease === true && !options.allowPrerelease) {
			continue;
		}
		if (!accept(release)) {
			continue;
		}
		const version = normalizeSemverVersion(release.tagName);
		if (!version) {
			continue;
		}
		if (bestVersion === null || semver.gt(version, bestVersion)) {
			best = release;
			bestVersion = version;
		}
	}

	return best;
}

/** True when the running build is not older than the given release tag. */
export function isBuildUpToDateVersusTag(localVersion: string, remoteTagName: string): boolean {
	const remote = normalizeSemverVersion(remoteTagName);
	const local = normalizeSemverVersion(localVersion);
	if (!remote) {
		return true;
	}
	if (!local) {
		return localVersion.trim() === remoteTagName.trim();
	}
	return semver.gte(local, remote);
}
