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
 */

export interface ReasoningContinuityInput {
	/** Model the conversation has been running on. */
	readonly fromModel: string;
	/** Model it is about to continue on. */
	readonly toModel: string;
	/** Does the model's quirk entry mark its reasoning as model-bound? */
	readonly reasoningBoundToModel: (model: string) => boolean;
}

/**
 * True when continuing on `toModel` silently discards `fromModel`'s reasoning.
 *
 * A switch to the same model keeps everything, so it is never a loss. A switch away from a
 * model-bound family always is — including a switch to another model of that same family, because
 * the binding is to the model, not the vendor.
 */
export function reasoningLostOnSwitch(input: ReasoningContinuityInput): boolean {
	const { fromModel, toModel, reasoningBoundToModel } = input;
	if (!fromModel || !toModel || fromModel === toModel) {
		return false;
	}
	return reasoningBoundToModel(fromModel);
}
