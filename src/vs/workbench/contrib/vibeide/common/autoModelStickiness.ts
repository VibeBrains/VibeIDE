/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * «Авто» выбирает модель на разговор, а не на сообщение.
 *
 * WHY: the router used to run on every message, so a thread could change model mid-conversation —
 * the prompt cache of the previous model is dropped (we pay the whole history again as fresh input)
 * and the voice of the answers changes between two lines of the same task. AIP-57 states the same
 * rule for its chains: the choice is attached to the conversation, and metrics, prices and the wire
 * body must all see the model that actually served it.
 *
 * The pin is deliberately narrow. It carries only what would make the earlier choice WRONG now, so a
 * revisit happens on a real change and not on a hunch:
 *   - the chat mode changed — a different mode asks for different work;
 *   - this message carries an image or a PDF and the pinned model cannot read them;
 *   - the pinned model is gone (provider disabled, key removed, entry deleted from `providers.json`).
 * Everything else — a longer message, a new task type, a different language — is the same
 * conversation, and switching model inside it costs more than it buys.
 */

import { ModelSelection } from './vibeideSettingsTypes.js';

/** What «Авто» decided for this thread, and under which conditions. */
export interface AutoModelPin {
	readonly selection: ModelSelection;
	/** Chat mode at the moment of the decision. */
	readonly chatMode: string;
	/** Whether the pinned model can read images/PDFs — so an attachment later can force a revisit. */
	readonly vision: boolean;
}

/** What the current message needs. */
export interface AutoModelSituation {
	readonly chatMode: string;
	readonly needsVision: boolean;
	/** Is this selection still offered by settings (provider enabled, key present, model not removed)? */
	readonly isAvailable: (selection: ModelSelection) => boolean;
}

/**
 * The model to keep for this message, or `undefined` when the router must decide again.
 */
export function pinnedAutoModel(pin: AutoModelPin | undefined, situation: AutoModelSituation): ModelSelection | undefined {
	if (!pin) {
		return undefined;
	}
	if (pin.chatMode !== situation.chatMode) {
		return undefined;
	}
	if (situation.needsVision && !pin.vision) {
		return undefined;
	}
	if (!situation.isAvailable(pin.selection)) {
		return undefined;
	}
	return pin.selection;
}
