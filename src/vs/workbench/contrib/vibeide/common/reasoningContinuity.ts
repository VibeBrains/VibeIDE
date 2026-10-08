/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Does a model switch throw away the reasoning built up so far? — pure decision, no I/O.
 *
 * Some families bind their reasoning blocks to the producing model: Anthropic says Fable 5.1 reads
 * earlier models' thinking, but no earlier model reads its own. Nothing errors when those blocks
 * travel — they are dropped and not billed. That is exactly why it needs saying: after a failover
 * the agent keeps working without the chain of thought it had, the answers get shallower, and
 * nobody is told why. We cannot preserve the reasoning; we can refuse to lose it quietly.
 *
 * The verdict comes from the quirks catalogue rather than a list of model names here — which family
 * behaves this way is an observation about a vendor, and observations belong in the catalogue where
 * they carry a source and a date.
 * The exceptions below are the one part kept here: they are pairs of models, not a property of one,
 * and the catalogue has no field for a pair
 */

export interface ReasoningContinuityInput {
	/** Model the conversation has been running on. */
	readonly fromModel: string;
	/** Model it is about to continue on. */
	readonly toModel: string;
	/** Does the model's quirk entry mark its reasoning as model-bound? */
	readonly reasoningBoundToModel: (model: string) => boolean;
	/** Provider the conversation has been running on, when known */
	readonly fromProvider?: string;
	/** Provider it is about to continue on, when known */
	readonly toProvider?: string;
}

/**
 * Switches the vendor names as readable despite the binding: the next model reads the earlier blocks
 * The blocks are also bound to the account, so a pair holds only when the provider stays the same
 */
const READABLE_SWITCHES: readonly { readonly from: RegExp; readonly to: RegExp; readonly onlyOn?: string }[] = [
	// «Opus 5.5 thinking blocks are readable by Claude Fable 5.1 and Claude Mythos 5.1»
	// (platform.claude.com/docs/en/models/opus-5-5/migration-guide, checked 01.10.2026)
	{ from: /opus-?5[-.]5/i, to: /(fable|mythos)-?5[-.]1/i },
	// Opus 5.5 reads Sonnet 5.5 blocks on the Claude API only (platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)
	{ from: /sonnet-?5[-.]5/i, to: /opus-?5[-.]5/i, onlyOn: 'anthropic' },
	// Opus 5.5 and Sonnet 5.5 read Haiku 5.5 blocks on the Claude API and Google Cloud
	// (platform.claude.com/docs/en/build-with-claude/thinking, «Switching models mid-conversation», checked 08.10.2026)
	{ from: /haiku-?5[-.]5/i, to: /opus-?5[-.]5/i, onlyOn: 'anthropic' },
	{ from: /haiku-?5[-.]5/i, to: /sonnet-?5[-.]5/i, onlyOn: 'anthropic' },
];

function readableSwitch(input: ReasoningContinuityInput): boolean {
	const { fromModel, toModel, fromProvider, toProvider } = input;
	if (fromProvider && toProvider && fromProvider !== toProvider) {
		return false;
	}
	return READABLE_SWITCHES.some(pair => pair.from.test(fromModel) && pair.to.test(toModel)
		&& (!pair.onlyOn || (fromProvider === pair.onlyOn && toProvider === pair.onlyOn)));
}

/**
 * True when continuing on `toModel` silently discards `fromModel`'s reasoning.
 *
 * A switch to the same model keeps everything, so it is never a loss. A switch away from a
 * model-bound family is — including a switch to another model of that same family, because
 * the binding is to the model, not the vendor — unless the vendor names the pair as readable.
 */
export function reasoningLostOnSwitch(input: ReasoningContinuityInput): boolean {
	const { fromModel, toModel, reasoningBoundToModel } = input;
	if (!fromModel || !toModel || fromModel === toModel) {
		return false;
	}
	return reasoningBoundToModel(fromModel) && !readableSwitch(input);
}
