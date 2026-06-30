/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * CLI ↔ IDE version mismatch detection (1136) — pure helper.
 *
 * `vibe --version` reads `vibeVersion` from `product.json`. When the user
 * has a global `vibe` CLI installed but the local IDE was upgraded
 * (different `vibeVersion`), the CLI may produce stale output (different
 * doctor checks, missing subcommands). This helper compares the two
 * versions and produces a banner descriptor for the IDE / `vibe doctor`.
 *
 * Semver compare without external deps: split by `.`, compare numeric
 * components left-to-right; pre-release tags (`-rc.1`, `-alpha.2`) are
 * lexicographically lower than the release version per SemVer 2.0.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type VersionDelta = 'same' | 'cli-newer' | 'cli-older' | 'unparseable';

export interface SemverParts {
	major: number;
	minor: number;
	patch: number;
	prerelease: string;
}

/**
 * Parse a semver string. Returns null when the input doesn't look like a
 * standard `major.minor.patch[-prerelease]` triple.
 */
export function parseSemver(raw: unknown): SemverParts | null {
	if (typeof raw !== 'string') { return null; }
	const m = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
	if (!m) { return null; }
	const major = Number(m[1]);
	const minor = Number(m[2]);
	const patch = Number(m[3]);
	if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
		return null;
	}
	return {
		major, minor, patch,
		prerelease: m[4] ?? '',
	};
}

/**
 * Compare two parsed semver structures. Returns -1 / 0 / 1. Pure.
 */
export function compareSemver(a: SemverParts, b: SemverParts): -1 | 0 | 1 {
	if (a.major !== b.major) { return a.major < b.major ? -1 : 1; }
	if (a.minor !== b.minor) { return a.minor < b.minor ? -1 : 1; }
	if (a.patch !== b.patch) { return a.patch < b.patch ? -1 : 1; }
	// Per SemVer 2.0: a version with a prerelease is LOWER than the same
	// version without one (1.0.0-rc < 1.0.0).
	if (a.prerelease === b.prerelease) { return 0; }
	if (a.prerelease === '') { return 1; }  // a is the release, b is prerelease → a > b
	if (b.prerelease === '') { return -1; } // mirror
	// Both have prerelease — lexicographic compare on the tag string.
	return a.prerelease < b.prerelease ? -1 : 1;
}

export interface MismatchInput {
	cliVersion: string;
	ideVersion: string;
}

export type MismatchSeverity = 'none' | 'patch' | 'minor' | 'major';

export interface MismatchResult {
	delta: VersionDelta;
	severity: MismatchSeverity;
	headline: string;
	suggestion: string;
}

/**
 * Compute the mismatch report. Pure.
 *
 * Severity:
 *   - same → none
 *   - patch differs → patch
 *   - minor differs → minor (likely API drift in some commands)
 *   - major differs → major (incompatible CLI; warn loudly)
 *   - unparseable → severity = none, delta = unparseable, suggestion
 *     tells the user which side failed to parse.
 */
export function detectVersionMismatch(input: MismatchInput): MismatchResult {
	const cli = parseSemver(input.cliVersion);
	const ide = parseSemver(input.ideVersion);
	if (!cli || !ide) {
		const which = !cli && !ide ? 'both' : !cli ? 'CLI' : 'IDE';
		return {
			delta: 'unparseable',
			severity: 'none',
			headline: 'CLI/IDE version unreadable',
			suggestion: `Could not parse ${which} version string. Check product.json and \`vibe --version\` output.`,
		};
	}
	if (cli.major === ide.major && cli.minor === ide.minor && cli.patch === ide.patch && cli.prerelease === ide.prerelease) {
		return {
			delta: 'same',
			severity: 'none',
			headline: 'CLI ↔ IDE versions match',
			suggestion: '',
		};
	}
	const cmp = compareSemver(cli, ide);
	const delta: VersionDelta = cmp < 0 ? 'cli-older' : 'cli-newer';
	const severity: MismatchSeverity =
		cli.major !== ide.major ? 'major'
			: cli.minor !== ide.minor ? 'minor'
				: 'patch';

	const headline =
		severity === 'major'
			? `Major CLI/IDE mismatch — CLI ${input.cliVersion} vs IDE ${input.ideVersion}`
			: severity === 'minor'
				? `CLI/IDE minor mismatch — CLI ${input.cliVersion} vs IDE ${input.ideVersion}`
				: `CLI/IDE patch mismatch — CLI ${input.cliVersion} vs IDE ${input.ideVersion}`;

	const suggestion = delta === 'cli-older'
		? `CLI is older than the IDE. Reinstall the CLI: \`npm i -g vibeide-cli@${input.ideVersion}\`.`
		: `CLI is newer than the IDE. Upgrade the IDE or downgrade the CLI to match.`;

	return { delta, severity, headline, suggestion };
}
