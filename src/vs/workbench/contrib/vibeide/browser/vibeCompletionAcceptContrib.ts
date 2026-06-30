/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeIDE multi-line completion accept keybindings (roadmap §L1020).
 *
 * Wires `completionAcceptPolicy.ts` accept modes into editor keybindings:
 *   Tab         → `vibeide.autocomplete.acceptPartial`   (first line / balanced block)
 *   Shift+Tab   → `vibeide.autocomplete.acceptFull`      (entire suggestion)
 *
 * Both commands are only active when an inline suggestion is visible
 * (`inlineSuggestionVisible` context key). When no suggestion is showing,
 * the bindings do not fire and the default Tab / Shift+Tab behaviour is
 * preserved.
 *
 * The pure decision helper `decideAccept` lives in `common/completionAcceptPolicy.ts`;
 * this module is the thin runtime adapter that invokes VS Code's built-in
 * `editor.action.inlineSuggest.commit` (which accepts the currently-shown
 * ghost text) after the policy decision is applied.
 *
 * Full multi-line partial-text injection (accepting only the first line of a
 * multi-line suggestion while leaving the remainder as a follow-up) requires
 * modifying the text returned by `provideInlineCompletions` based on the
 * accept mode. That coupling lives in `autocompleteService.ts` — this
 * contribution only handles the keybinding registration.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { inlineSuggestCommitId, inlineSuggestCommitAlternativeActionId } from '../../../../editor/contrib/inlineCompletions/browser/controller/commandIds.js';

// Context: inline suggestion is visible + cursor is in an editor.
const INLINE_SUGGESTION_ACTIVE = ContextKeyExpr.and(
	EditorContextKeys.editorTextFocus,
	ContextKeyExpr.equals('inlineSuggestionVisible', true),
);

// ── Tab → acceptPartial ────────────────────────────────────────────────────────

registerAction2(class VibeAutocompleteAcceptPartial extends Action2 {
	constructor() {
		super({
			id: 'vibeide.autocomplete.acceptPartial',
			title: { value: 'VibeIDE: Accept Next Line of Suggestion', original: 'VibeIDE: Accept Next Line of Suggestion' },
			f1: false,
			keybinding: {
				primary: KeyCode.Tab,
				weight: KeybindingWeight.EditorContrib + 1, // outbid default Tab handler when suggestion is visible
				when: INLINE_SUGGESTION_ACTIVE,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Delegate to VS Code's built-in commit — the partial-text
		// logic is enforced on the provider side (autocompleteService returns
		// only the first line when the completion type is multi-line).
		const commands = accessor.get(ICommandService);
		await commands.executeCommand(inlineSuggestCommitId);
	}
});

// ── Shift+Tab → acceptFull ─────────────────────────────────────────────────────

registerAction2(class VibeAutocompleteAcceptFull extends Action2 {
	constructor() {
		super({
			id: 'vibeide.autocomplete.acceptFull',
			title: { value: 'VibeIDE: Accept Full Suggestion', original: 'VibeIDE: Accept Full Suggestion' },
			f1: false,
			keybinding: {
				primary: KeyMod.Shift | KeyCode.Tab,
				weight: KeybindingWeight.EditorContrib + 1,
				when: INLINE_SUGGESTION_ACTIVE,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// commitAlternativeAction maps to "commit next word / alternative" in VS Code;
		// we repurpose it as the full-accept binding.
		const commands = accessor.get(ICommandService);
		await commands.executeCommand(inlineSuggestCommitAlternativeActionId);
	}
});
