/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * i18n bundle ↔ `product.json:vibeVersion` sync check — pure helper
 * (roadmap §"Pack VSIX → Версионирование: bundle pinned к
 * `product.json:vibeVersion` (не к VS Code `version`); рассинхрон IDE↔bundle
 * ловится CI-проверкой").
 *
 * Pure helper — `vscode`-free. Caller already loaded `product.json` and the
 * VSIX `package.json`; helper compares the two version strings and returns
 * a tagged decision so the CI workflow / `vibe doctor` can route accordingly.
 */

export type BundleVersionVerdict =
	| { readonly kind: 'in-sync'; readonly version: string }
	| { readonly kind: 'mismatch'; readonly ideVersion: string; readonly bundleVersion: string; readonly drift: 'major' | 'minor' | 'patch' | 'unparseable' }
	| { readonly kind: 'invalid-input'; readonly reason: 'ide-missing' | 'bundle-missing' | 'ide-not-string' | 'bundle-not-string' | 'ide-malformed' | 'bundle-malformed' };

export interface BundleVersionCheckInput {
	readonly ideVersion: unknown;
	readonly bundleVersion: unknown;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/**
 * Pure verdict on whether the language-pack VSIX `package.json` version
 * matches `product.json:vibeVersion`.
 *
 *   - identical strings (after trim) → `in-sync`
 *   - both parseable but different   → `mismatch` with drift level
 *   - one or both unparseable        → `invalid-input` or `mismatch:unparseable`
 *   - either undefined / non-string  → `invalid-input`
 *
 * SemVer pre-release / build metadata is allowed but ignored when
 * computing drift level (only major/minor/patch numerics drive the verdict).
 */
export function checkBundleVersionSync(input: BundleVersionCheckInput): BundleVersionVerdict {
	if (input.ideVersion === undefined || input.ideVersion === null) {
		return { kind: 'invalid-input', reason: 'ide-missing' };
	}
	if (input.bundleVersion === undefined || input.bundleVersion === null) {
		return { kind: 'invalid-input', reason: 'bundle-missing' };
	}
	if (typeof input.ideVersion !== 'string') {
		return { kind: 'invalid-input', reason: 'ide-not-string' };
	}
	if (typeof input.bundleVersion !== 'string') {
		return { kind: 'invalid-input', reason: 'bundle-not-string' };
	}
	const ide = input.ideVersion.trim();
	const bundle = input.bundleVersion.trim();
	if (ide.length === 0) { return { kind: 'invalid-input', reason: 'ide-malformed' }; }
	if (bundle.length === 0) { return { kind: 'invalid-input', reason: 'bundle-malformed' }; }

	if (ide === bundle) {
		return { kind: 'in-sync', version: ide };
	}

	const ideParts = SEMVER_PATTERN.exec(ide);
	const bundleParts = SEMVER_PATTERN.exec(bundle);
	if (!ideParts || !bundleParts) {
		return { kind: 'mismatch', ideVersion: ide, bundleVersion: bundle, drift: 'unparseable' };
	}

	const [, iMajor, iMinor] = ideParts;
	const [, bMajor, bMinor] = bundleParts;

	let drift: 'major' | 'minor' | 'patch';
	if (iMajor !== bMajor) { drift = 'major'; }
	else if (iMinor !== bMinor) { drift = 'minor'; }
	else { drift = 'patch'; }

	return { kind: 'mismatch', ideVersion: ide, bundleVersion: bundle, drift };
}

/**
 * Build the CI failure message body. Pure formatter — caller posts via gh CLI.
 */
export function describeBundleVersionVerdict(v: BundleVersionVerdict): string {
	switch (v.kind) {
		case 'in-sync':
			return `✅ Language-pack bundle in sync with product.json:vibeVersion (${v.version}).`;
		case 'invalid-input':
			return `❌ Bundle version check: invalid input — ${v.reason}.`;
		case 'mismatch':
			return `❌ Language-pack bundle version mismatch — IDE \`${v.ideVersion}\` ≠ bundle \`${v.bundleVersion}\` (drift: ${v.drift}). Rebuild language pack via \`npm run build-language-packs\` against the current product.json.`;
	}
}
