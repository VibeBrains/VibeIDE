/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Hides VS Code's built-in Copilot Chat panel surfaces from the workbench UI.
 *
 * VibeIDE chat runs in `workbench.view.vibeide` (auxiliary bar). This CSS hides
 * legacy `workbench.panel.chat` / Copilot UI that might still appear.
 *
 * NOTE: We keep underlying services (ChatService, ILanguageModelToolsService, etc.)
 * intact because VibeIDE's chatThreadService depends on them. Only visible UI shells.
 *
 * Porting note (1.118+): composite bar items now use data-action-id attributes;
 * the inline chat button in the editor action bar uses .editor-chat-start-button.
 */

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { mainWindow } from '../../../../base/browser/window.js';

/** VS Code built-in chat container id (stable since 1.90, still correct in 1.118+). */
const CHAT_VIEW_CONTAINER_ID = 'workbench.panel.chat';

/*
 * Upstream's «Generate Commit Message» sparkle lives in the SCM input box (`scmInput.ts`, command
 * `scm.input.triggerSetup`). It is shown while the Copilot setup is NOT completed — and in VibeIDE
 * it never completes, so the button stays there forever, offering a flow we do not ship. VibeIDE
 * has its own commit-message generation; this is the other one's button.
 *
 * Hidden with CSS rather than by editing `scmInput.ts` (upstream files are not touched for our
 * preferences — `upstreamBoundary.md`) and rather than with `setForceHidden`, which would remove
 * the whole Copilot-setup surface instead of this single control. See the rule below for why it
 * matches the icon rather than the command id.
 */

const HIDE_CSS = /* css */ `
/* ── Auxiliary bar composite-bar tab for built-in chat ─────────────────── */
.monaco-workbench .part.auxiliarybar .action-item[data-action-id="${CHAT_VIEW_CONTAINER_ID}"],
.monaco-workbench .part.auxiliarybar .action-item[id="${CHAT_VIEW_CONTAINER_ID}"] {
	display: none !important;
}

/* ── Activity bar button that opens chat (shows when aux-bar is hidden) ── */
.monaco-workbench .part.activitybar .action-item[data-action-id="${CHAT_VIEW_CONTAINER_ID}"],
.monaco-workbench .part.activitybar .action-item[aria-label="Chat"] {
	display: none !important;
}

/* ── Sidebar (primary / secondary) composite-bar tab ─────────────────── */
.monaco-workbench .part.sidebar .action-item[data-action-id="${CHAT_VIEW_CONTAINER_ID}"] {
	display: none !important;
}

/* ── Panel bar (bottom panel) composite-bar tab ─────────────────────── */
.monaco-workbench .part.panel .composite-bar .action-item[data-action-id="${CHAT_VIEW_CONTAINER_ID}"] {
	display: none !important;
}

/* ── Inline chat floating widget inside the editor ───────────────────── */
.monaco-workbench .inline-chat-widget,
.monaco-workbench .editor-chat-start-button {
	display: none !important;
}

/* ── "Open Chat" button that occasionally appears in editor decorations ── */
.monaco-workbench [data-action-id*="inlineChat.start"],
.monaco-workbench [data-action-id*="chat.open"] {
	display: none !important;
}

/* ── Native Copilot CHAT header/title buttons in secondary sidebar ───── */
/* Targets the "CHAT" label button rendered by agentSessionsExperiments    */
.monaco-workbench .part.auxiliarybar .title .chat-sessions-panel,
.monaco-workbench .part.auxiliarybar [aria-label="Chat (Ctrl+Alt+I)"],
.monaco-workbench .part.auxiliarybar [aria-label="Chat"],
.monaco-workbench .editor-group-container .chat-editor-container {
	display: none !important;
}

/* ── AgentTitleBarStatusWidget: CHAT / Copilot status area in title bar ─ */
.monaco-workbench .part.titlebar .agent-title-bar-status,
.monaco-workbench .part.titlebar .agents-title-bar-widget {
	display: none !important;
}

/* ── Upstream «Generate Commit Message» sparkle in the SCM input box ──── */
/* Scoped to the SCM input toolbar and matched by the codicon: action items are plain <li> with  */
/* no attribute carrying the command id (checked in actionbar.ts — data-action-id is never set   */
/* by upstream), so the glyph inside the SCM input is the only thing there is to match. The scope */
/* is what keeps this from taking unrelated sparkle buttons with it.                             */
.monaco-workbench .scm-editor-container .monaco-action-bar .codicon-sparkle,
.monaco-workbench .scm-editor .monaco-action-bar .codicon-sparkle {
	display: none !important;
}

/* ── Belt-and-suspenders: any chatSparkle icon inside title bar area ─── */
/* (catches fallback rendering if the menu registration is ever re-enabled) */
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
