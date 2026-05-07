/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Normally you'd want to put these exports in the files that register them, but if you do that you'll get an import order error if you import them in certain cases.
// (importing them runs the whole file to get the ID, causing an import error). I guess it's best practice to separate out IDs, pretty annoying...

export const VIBEIDE_CTRL_L_ACTION_ID = 'vibeide.ctrlLAction';

/** Quick pick over all chat threads (sidebar history button / Command Center). */
export const VIBEIDE_SHOW_CHAT_HISTORY_CMD = 'vibeide.showChatHistory';

export const VIBEIDE_CTRL_K_ACTION_ID = 'vibeide.ctrlKAction';

export const VIBEIDE_ACCEPT_DIFF_ACTION_ID = 'vibeide.acceptDiff';

export const VIBEIDE_REJECT_DIFF_ACTION_ID = 'vibeide.rejectDiff';

export const VIBEIDE_GOTO_NEXT_DIFF_ACTION_ID = 'vibeide.goToNextDiff';

export const VIBEIDE_GOTO_PREV_DIFF_ACTION_ID = 'vibeide.goToPrevDiff';

export const VIBEIDE_GOTO_NEXT_URI_ACTION_ID = 'vibeide.goToNextUri';

export const VIBEIDE_GOTO_PREV_URI_ACTION_ID = 'vibeide.goToPrevUri';

export const VIBEIDE_ACCEPT_FILE_ACTION_ID = 'vibeide.acceptFile';

export const VIBEIDE_REJECT_FILE_ACTION_ID = 'vibeide.rejectFile';

export const VIBEIDE_ACCEPT_ALL_DIFFS_ACTION_ID = 'vibeide.acceptAllDiffs';

export const VIBEIDE_REJECT_ALL_DIFFS_ACTION_ID = 'vibeide.rejectAllDiffs';

/** Open the chat editor pane in the right split column. */
export const VIBEIDE_OPEN_CHAT_EDITOR_CMD = 'vibeide.chat.open';

/** Open a brand-new chat tab in the chat group (subject to `vibeide.chat.maxOpenTabs`). */
export const VIBEIDE_NEW_CHAT_CMD = 'vibeide.chat.openNew';
