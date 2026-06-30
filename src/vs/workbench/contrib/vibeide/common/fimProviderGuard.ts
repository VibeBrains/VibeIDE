/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * FIM (tab-completion) privacy guard (1021, 1022).
 *
 * Purpose: when `vibeide.privacy.strict = true`, only local providers
 * (Ollama localhost / lmstudio localhost) may serve tab completion. Cloud
 * providers configured for chat must NOT be reused here. Auto-deactivation
 * in noise-heavy paths (`node_modules`, `build`, minified files) is in the
 * same module — saves tokens and reduces UI churn.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type ProviderKind = 'local' | 'cloud' | 'unknown';

export interface FIMRequestContext {
	/** Provider id the runtime would pick by default. */
	defaultProviderId: string;
	/** Map provider id → kind. Caller derives this from VibeProviderCapabilityService. */
	providerKinds: Readonly<Record<string, ProviderKind>>;
	/** True when `vibeide.privacy.strict` is on. */
	privacyStrict: boolean;
	/** Path of the file the cursor is in, normalised to forward slashes. */
	filePath: string;
	/** True if the file is detected as minified (.min.js, single-line >2k chars, etc.). */
	isMinified?: boolean;
}

export type FIMGuardDecision =
	| { kind: 'allow'; providerId: string }
	| { kind: 'block'; reason: 'privacy-strict-cloud' | 'noise-path' | 'minified' | 'unknown-provider' };

const NOISE_PATTERNS = [
	/(^|\/)node_modules\//,
	/(^|\/)build\//,
	/(^|\/)dist\//,
	/(^|\/)out\//,
	/(^|\/)\.next\//,
	/\.min\.(js|css)$/,
	/\.map$/,
];

export const NOISE_PATH_PATTERNS: ReadonlyArray<RegExp> = NOISE_PATTERNS;

export function isNoisePath(filePath: string): boolean {
	if (typeof filePath !== 'string' || filePath.length === 0) { return false; }
	const normalised = filePath.replace(/\\/g, '/');
	return NOISE_PATTERNS.some(re => re.test(normalised));
}

/**
 * Decide whether FIM is allowed for this request and which provider serves it.
 * Pure — no settings reads, no IO. Caller passes `privacyStrict` and the
 * provider-kind map in.
 */
export function guardFIMRequest(ctx: FIMRequestContext): FIMGuardDecision {
	if (ctx.isMinified) {
		return { kind: 'block', reason: 'minified' };
	}
	if (isNoisePath(ctx.filePath)) {
		return { kind: 'block', reason: 'noise-path' };
	}
	const kind = ctx.providerKinds[ctx.defaultProviderId];
	if (kind === undefined) {
		return { kind: 'block', reason: 'unknown-provider' };
	}
	if (ctx.privacyStrict && kind !== 'local') {
		return { kind: 'block', reason: 'privacy-strict-cloud' };
	}
	return { kind: 'allow', providerId: ctx.defaultProviderId };
}

/**
 * Pick the first local provider from a list, given the kinds map. Returns
 * `undefined` when no local provider is configured — caller should surface
 * a "configure Ollama / lmstudio for FIM" toast.
 */
export function pickFirstLocalProvider(
	candidates: ReadonlyArray<string>,
	providerKinds: Readonly<Record<string, ProviderKind>>,
): string | undefined {
	for (const id of candidates) {
		if (providerKinds[id] === 'local') { return id; }
	}
	return undefined;
}
