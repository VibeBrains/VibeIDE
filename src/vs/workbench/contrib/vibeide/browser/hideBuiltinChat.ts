/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Hides VS Code's built-in Copilot Chat surfaces from the workbench UI.
 *
 * VibeIDE chat runs in `workbench.view.vibeide` (auxiliary bar). This CSS is a safety net for
 * built-in chat UI that might still render — the surfaces themselves come with the Copilot Chat
 * extension, which this product does not ship.
 *
 * NOTE: We keep underlying services (ChatService, ILanguageModelToolsService, etc.)
 * intact because VibeIDE's chatThreadService depends on them. Only visible UI shells.
 *
 * **Verified against a running IDE on 2026-08-14** — and most of what stood here did nothing:
 *
 *  - Five rules keyed on `data-action-id`. That attribute **does not exist** anywhere in the
 *    workbench: composite bar items carry only `class`, `role`, `draggable`, `aria-*`, `tabindex`
 *    and `style`. A porting note from 1.118 claimed otherwise and was never checked.
 *  - `[id="workbench.panel.chat"]`: the composite id is never written to the DOM either.
 *  - **Two rules matched OUR OWN chat.** `.part.auxiliarybar [aria-label="Chat"]` was measured
 *    hitting `.view-workbench-view-vibeide-chat` — the VibeIDE tab itself, which sits in that very
 *    part and is labelled "Чат" today only because the UI is Russian. Under an English locale the
 *    rule would have hidden our own chat. This is exactly what the project's own localization rule
 *    forbids: never branch on the text of a string, it is different in every language.
 *
 * What remains keys on upstream CSS classes, which are stable, cannot collide with our own markup,
 * and cost nothing while the surfaces are absent.
 */

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { mainWindow } from '../../../../base/browser/window.js';

const HIDE_CSS = /* css */ `
/* ── Inline chat floating widget inside the editor ───────────────────── */
.monaco-workbench .inline-chat-widget,
.monaco-workbench .editor-chat-start-button {
	display: none !important;
}

/* ── Chat opened as an editor tab ─────────────────────────────────────── */
.monaco-workbench .editor-group-container .chat-editor-container,
.monaco-workbench .part.auxiliarybar .title .chat-sessions-panel {
	display: none !important;
}

/* ── AgentTitleBarStatusWidget: CHAT / Copilot status area in title bar ─ */
.monaco-workbench .part.titlebar .agent-title-bar-status,
.monaco-workbench .part.titlebar .agents-title-bar-widget,
.monaco-workbench .part.titlebar .codicon-chat-sparkle {
	display: none !important;
}

/* ── Fix: unified-agents-bar hides .command-center-center (workspace name) ─ */
/* AgentTitleBarStatusRendering adds .unified-agents-bar to body once          */
/* chatIsEnabled fires; its CSS then hides the workspace name to make room for */
/* the native AgentsTitleBarControlMenu — which VibeIDE has disabled.          */
/* Restore the workspace name / search label so it always stays visible.       */
.unified-agents-bar .command-center .action-item.command-center-center {
	display: flex !important;
}
`;

class HideBuiltinChatContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeide.hideBuiltinChat';

	constructor() {
		super();
		const styleEl = createStyleSheet(mainWindow.document.head, el => { el.textContent = HIDE_CSS; });
		this._register(toDisposable(() => styleEl.remove()));
	}
}

registerWorkbenchContribution2(
	HideBuiltinChatContribution.ID,
	HideBuiltinChatContribution,
	WorkbenchPhase.BlockRestore // apply before any UI is shown
);
