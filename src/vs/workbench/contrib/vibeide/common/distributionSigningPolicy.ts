/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Distribution signing policy — pure decision helper that turns the available
 * signing credentials + target platform into one of:
 *   - sign (with credential reference)
 *   - skip (and surface a clear "this build is unsigned" warning)
 *   - block (release script must refuse to publish unsigned binaries)
 *
 * Roadmap §888 (Distribution readiness gate). The four sub-items
 * (Win EV cert / macOS notarization / Universal Binary / ARM Linux) are
 * coupled — the gate either lets all four through or refuses to call the
 * release fully ready. This helper captures the rules; the build scripts
 * (release-windows.ps1, sign-windows.ps1, notarize-macos.sh) do the actual
 * signing.
 *
 * Pure: caller injects environment + target. No `fs` / `child_process`.
 */

export type Platform = 'win32-x64' | 'win32-arm64' | 'darwin-x64' | 'darwin-arm64' | 'darwin-universal' | 'linux-x64' | 'linux-arm64';

export interface SigningCredentials {
	readonly winEvCertPresent: boolean;
	readonly winTimestampServerUrl?: string;
	readonly macAppleId?: string;
	readonly macTeamId?: string;
	readonly macAppPasswordPresent: boolean;
	readonly linuxGpgKeyId?: string;
}

export type SigningDecision =
	| { readonly action: 'sign'; readonly platform: Platform; readonly credentialRef: string; readonly steps: ReadonlyArray<SigningStep> }
	| { readonly action: 'skip-unsigned'; readonly platform: Platform; readonly reason: SkipReason; readonly remediation: string }
	| { readonly action: 'block-release'; readonly platform: Platform; readonly reason: BlockReason; readonly remediation: string };

export type SigningStep = 'sign-binary' | 'timestamp' | 'verify' | 'notarize' | 'staple' | 'gpg-detach-sig';

export type SkipReason =
	| 'no-credentials-explicitly-allowed'
	| 'dev-build'
	| 'platform-no-signing-required';

export type BlockReason =
	| 'release-mode-but-no-credentials'
	| 'partial-credentials-incomplete-chain';

export interface DecideOptions {
	readonly platform: Platform;
	readonly credentials: SigningCredentials;
	/**
	 * `release` requires signing; `dev` and `nightly` permit unsigned with warning.
	 */
	readonly buildKind: 'dev' | 'nightly' | 'release';
	/**
	 * If true, missing credentials downgrade to skip-unsigned even for release.
	 * Set via env `VIBE_RELEASE_ALLOW_UNSIGNED=1` for emergency builds.
	 */
	readonly allowUnsignedRelease?: boolean;
}

export function decideSigning(opts: DecideOptions): SigningDecision {
	const { platform, credentials, buildKind, allowUnsignedRelease = false } = opts;

	if (buildKind === 'dev') {
		return {
			action: 'skip-unsigned',
			platform,
			reason: 'dev-build',
			remediation: 'Dev builds are not signed by design — install via `run-dev.bat` or `npm run watch`.',
		};
	}

	if (platform.startsWith('linux')) {
		return decideLinux(platform, credentials, buildKind);
	}

	if (platform.startsWith('win32')) {
		return decideWindows(platform, credentials, buildKind, allowUnsignedRelease);
	}

	if (platform.startsWith('darwin')) {
		return decideMacOS(platform, credentials, buildKind, allowUnsignedRelease);
	}

	return {
		action: 'block-release',
		platform,
		reason: 'partial-credentials-incomplete-chain',
		remediation: `Unknown platform "${platform}" — extend distributionSigningPolicy.ts.`,
	};
}

function decideWindows(platform: Platform, c: SigningCredentials, buildKind: DecideOptions['buildKind'], allowUnsigned: boolean): SigningDecision {
	if (!c.winEvCertPresent) {
		if (buildKind === 'release' && !allowUnsigned) {
			return {
				action: 'block-release',
				platform,
				reason: 'release-mode-but-no-credentials',
				remediation: 'Plug the Windows EV signing token (Sectigo / DigiCert hardware token) and set VIBE_WIN_CERT=1. See references/v1/distribution-signing-runbook.md.',
			};
		}
		return {
			action: 'skip-unsigned',
			platform,
			reason: 'no-credentials-explicitly-allowed',
			remediation: 'Build will be flagged by Windows SmartScreen as "unrecognized publisher". Acquire an EV cert before public release.',
		};
	}
	const steps: SigningStep[] = ['sign-binary'];
	if (c.winTimestampServerUrl) { steps.push('timestamp'); }
	steps.push('verify');
	return {
		action: 'sign',
		platform,
		credentialRef: 'win-ev-token',
		steps,
	};
}

function decideMacOS(platform: Platform, c: SigningCredentials, buildKind: DecideOptions['buildKind'], allowUnsigned: boolean): SigningDecision {
	const hasNotarizationCreds = !!(c.macAppleId && c.macTeamId && c.macAppPasswordPresent);
	if (!hasNotarizationCreds) {
		if (buildKind === 'release' && !allowUnsigned) {
			return {
				action: 'block-release',
				platform,
				reason: 'release-mode-but-no-credentials',
				remediation: 'Set APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD env vars (Apple Developer account required, ~$99/y). See references/v1/distribution-signing-runbook.md.',
			};
		}
		return {
			action: 'skip-unsigned',
			platform,
			reason: 'no-credentials-explicitly-allowed',
			remediation: 'Build will be Gatekeeper-blocked on first launch. Acquire Apple Developer credentials before public release.',
		};
	}
	return {
		action: 'sign',
		platform,
		credentialRef: 'apple-notary',
		steps: ['sign-binary', 'notarize', 'staple', 'verify'],
	};
}

function decideLinux(platform: Platform, c: SigningCredentials, buildKind: DecideOptions['buildKind']): SigningDecision {
	if (!c.linuxGpgKeyId) {
		return {
			action: 'skip-unsigned',
			platform,
			reason: 'platform-no-signing-required',
			remediation: 'Linux distros do not require code-signing for run-from-tarball / AppImage. Provide GPG key via VIBE_LINUX_GPG_KEY for repository (.deb/.rpm) signing.',
		};
	}
	return {
		action: 'sign',
		platform,
		credentialRef: `gpg:${c.linuxGpgKeyId.slice(0, 16)}`,
		steps: ['gpg-detach-sig', 'verify'],
	};
}

// -----------------------------------------------------------------------------
// Distribution readiness gate (roadmap §888): all four platforms must be
// signable for the gate to pass.
// -----------------------------------------------------------------------------

export type ReadinessGate =
	| { readonly status: 'ready'; readonly platforms: ReadonlyArray<Platform> }
	| { readonly status: 'not-ready'; readonly missing: ReadonlyArray<{ platform: Platform; reason: BlockReason | SkipReason; remediation: string }> };

export function evaluateReadinessGate(
	platforms: ReadonlyArray<Platform>,
	credentials: SigningCredentials,
): ReadinessGate {
	const missing: { platform: Platform; reason: BlockReason | SkipReason; remediation: string }[] = [];
	for (const p of platforms) {
		const decision = decideSigning({ platform: p, credentials, buildKind: 'release' });
		if (decision.action !== 'sign') {
			missing.push({ platform: p, reason: decision.reason, remediation: decision.remediation });
		}
	}
	if (missing.length === 0) {
		return { status: 'ready', platforms };
	}
	return { status: 'not-ready', missing };
}

export function describeDecision(decision: SigningDecision): string {
	switch (decision.action) {
		case 'sign':
			return `[${decision.platform}] sign via ${decision.credentialRef}: ${decision.steps.join(' → ')}`;
		case 'skip-unsigned':
			return `[${decision.platform}] UNSIGNED (${decision.reason}): ${decision.remediation}`;
		case 'block-release':
			return `[${decision.platform}] BLOCKED (${decision.reason}): ${decision.remediation}`;
	}
}
