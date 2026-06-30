/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * FIM-specific provider routing (1019) — pure helper.
 *
 * Tab completion uses a fast, dedicated provider — distinct from chat
 * routing (`modelRoutingByPath.ts`). Default preference order:
 *   1. user-pinned `vibeide.completion.modelId` if set + available
 *   2. local Ollama coder model (qwen2.5-coder, deepseek-coder)
 *   3. local lmstudio coder model
 *   4. fall back to chat default ONLY when no local model is available
 *      AND `vibeide.privacy.strict` is off
 *
 * This module returns a typed decision; the caller (autocompleteService)
 * applies it and surfaces a banner when the chosen provider differs from
 * the user's expectation.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type FIMProviderKind = 'local-ollama' | 'local-lmstudio' | 'cloud';

export interface FIMProvider {
	id: string;
	kind: FIMProviderKind;
	/** True if the provider is available (binary running, model loaded). */
	available: boolean;
	/** True if the provider has a coder-tuned model on the registry. */
	hasCoderModel?: boolean;
}

export interface FIMRoutingInput {
	/** User's `vibeide.completion.modelId` setting; empty = unset. */
	pinnedModelId: string;
	/** True if `vibeide.privacy.strict` is on. */
	privacyStrict: boolean;
	/** All providers known to VibeProviderCapabilityService. */
	providers: ReadonlyArray<FIMProvider>;
	/** Chat default provider id, used as last-resort fallback. */
	chatDefaultProviderId: string;
}

export type FIMRoutingDecision =
	| { kind: 'pinned'; providerId: string }
	| { kind: 'local-coder'; providerId: string; family: 'ollama' | 'lmstudio' }
	| { kind: 'fallback-chat-default'; providerId: string }
	| { kind: 'no-provider-available'; reason: 'privacy-strict-no-local' | 'nothing-configured' };

/**
 * Decide which provider serves the next FIM request. Pure.
 *
 * Rules in priority order:
 *   1. If pinned model is available → use it.
 *   2. Else if any local coder provider is available → pick first by
 *      preference (Ollama > lmstudio > anything tagged hasCoderModel).
 *   3. Else if privacy strict → emit no-provider-available with reason
 *      `privacy-strict-no-local` (never silently fall through to cloud).
 *   4. Else fall back to chat default.
 *   5. If chat default is also empty → no-provider-available with reason
 *      `nothing-configured`.
 */
export function decideFIMProvider(input: FIMRoutingInput): FIMRoutingDecision {
	const { pinnedModelId, privacyStrict, providers, chatDefaultProviderId } = input;

	if (pinnedModelId.length > 0) {
		const pinned = providers.find(p => p.id === pinnedModelId);
		if (pinned && pinned.available) {
			return { kind: 'pinned', providerId: pinned.id };
		}
	}

	const localCoder = pickLocalCoder(providers);
	if (localCoder) {
		return {
			kind: 'local-coder',
			providerId: localCoder.id,
			family: localCoder.kind === 'local-ollama' ? 'ollama' : 'lmstudio',
		};
	}

	if (privacyStrict) {
		return { kind: 'no-provider-available', reason: 'privacy-strict-no-local' };
	}

	if (chatDefaultProviderId.length === 0) {
		return { kind: 'no-provider-available', reason: 'nothing-configured' };
	}

	return { kind: 'fallback-chat-default', providerId: chatDefaultProviderId };
}

function pickLocalCoder(providers: ReadonlyArray<FIMProvider>): FIMProvider | undefined {
	const ollama = providers.find(p => p.available && p.kind === 'local-ollama' && p.hasCoderModel === true);
	if (ollama) { return ollama; }
	const lmstudio = providers.find(p => p.available && p.kind === 'local-lmstudio' && p.hasCoderModel === true);
	if (lmstudio) { return lmstudio; }
	// Fallback: any local provider, even without a coder-specific tag.
	return providers.find(p => p.available && (p.kind === 'local-ollama' || p.kind === 'local-lmstudio'));
}

/**
 * Render a one-line UX hint for the routing decision, used when the
 * runtime wants to explain "why this provider" to the user.
 */
export function describeFIMRouting(decision: FIMRoutingDecision): string {
	switch (decision.kind) {
		case 'pinned':
			return `Tab completion: pinned model \`${decision.providerId}\`.`;
		case 'local-coder':
			return `Tab completion: local ${decision.family} coder model.`;
		case 'fallback-chat-default':
			return `Tab completion: falling back to chat default \`${decision.providerId}\`. Configure a local coder model for faster completion.`;
		case 'no-provider-available':
			return decision.reason === 'privacy-strict-no-local'
				? 'Tab completion off: privacy=strict requires a local model.'
				: 'Tab completion off: no provider configured.';
	}
}
