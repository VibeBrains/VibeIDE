/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Refactor B (2026-06): the chat used to run as an EDITOR (`VibeChatEditorInput` in an isolated,
// locked, rightmost editor group). Keeping that group isolated required a web of listeners fighting
// VS Code's native group merge/split — every merge (e.g. closing the Settings editor) could dump a
// file into the chat group or strand the chat tab next to a file ("slipped panels"). That whole
// layer is GONE. The chat is now a first-class View (`VibeChatViewPane` in sidebarPane.ts), which is
// structurally immune to editor-group merges. "Multiple chats" are threads in chatThreadService;
// this module just routes open/new-chat commands to the view + the active thread, reworks the
// chat fullscreen modes for a view-hosted chat, and keeps a neutered editor serializer so legacy
// persisted chat tabs are dropped on restore instead of resurrecting stray "Chat" editors.

import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import * as nls from '../../../../nls.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { VIBEIDE_NEW_CHAT_CMD, VIBEIDE_OPEN_CHAT_EDITOR_CMD } from './actionIDs.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { VIBEIDE_CHAT_VIEW_ID } from './sidebarPane.js';
import { IChatThreadService } from './chatThreadService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';

// ---------------------------------------------------------------------------
// Open / new-chat routing (chat is a View now)
// ---------------------------------------------------------------------------

export interface OpenChatOptions {
	/** Open a brand-new chat thread. */
	newChat?: boolean;
	/** Focus this exact chat thread; create if missing. Wins over `newChat`. */
	chatId?: string;
}

export async function openVibeChatEditor(instantiationService: IInstantiationService, options: OpenChatOptions = {}): Promise<void> {
	// Resolve through invokeFunction so we get a fresh accessor — the caller's may be invalidated by an await.
	const { viewsService, chatThreadService } = instantiationService.invokeFunction(accessor => ({
		viewsService: accessor.get(IViewsService),
		chatThreadService: accessor.get(IChatThreadService),
	}));

	if (options.chatId) {
		chatThreadService.switchToThread(options.chatId);
	} else if (options.newChat) {
		chatThreadService.forceCreateNewThread();
	} else if (!chatThreadService.state.currentThreadId) {
		chatThreadService.openNewThread();
	}

	// Reveal + focus the chat view; the React chat re-renders for the active thread.
	// Auxiliary-bar width is owned by the React Sidebar (it knows the chat width + history-rail
	// collapsed state and resizes the bar to chat+rail on mount/toggle).
	await viewsService.openView(VIBEIDE_CHAT_VIEW_ID, /*focus*/ true);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_OPEN_CHAT_EDITOR_CMD,
			title: nls.localize2('vibeOpenChatEditor', 'VibeIDE: Open Chat'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await openVibeChatEditor(accessor.get(IInstantiationService));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_NEW_CHAT_CMD,
			title: nls.localize2('vibeNewChat', 'VibeIDE: New Chat'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await openVibeChatEditor(accessor.get(IInstantiationService), { newChat: true });
	}
});

// ---------------------------------------------------------------------------
// Legacy editor-input serializer (migration shim)
// Old workspaces persisted `VibeChatEditorInput` tabs (typeId workbench.input.vibe.chat) in their
// restored layout. The editor pane is gone, so deserialize() returns undefined → VS Code silently
// drops those tabs instead of resurrecting stray "Chat" editors. Kept for 1-2 versions to migrate
// legacy layouts, then this registration is removed entirely.
// ---------------------------------------------------------------------------

const LEGACY_CHAT_EDITOR_TYPE_ID = 'workbench.input.vibe.chat';

class VibeChatEditorInputSerializer implements IEditorSerializer {
	canSerialize(_editorInput: EditorInput): boolean { return false; }
	serialize(_input: EditorInput): string { return ''; }
	deserialize(_instantiationService: IInstantiationService, _serializedEditor: string): EditorInput | undefined { return undefined; }
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	LEGACY_CHAT_EDITOR_TYPE_ID,
	VibeChatEditorInputSerializer,
);

// ---------------------------------------------------------------------------
// Migration cleanup: remove the obsolete locked chat EDITOR group.
// Pre-refactor the chat ran in an isolated, locked editor group (id persisted under
// `vibeide.chatEditorGroupId`). After moving chat into a View, the serializer above drops the chat
// tabs, but the now-empty LOCKED group can survive in the restored layout as a dead panel. Unlock it
// and close it (empty → nothing is lost), then forget the stale id. One-shot; safe to keep for a few
// versions. Also sweeps any other empty locked group left behind by the old lockdown.
// ---------------------------------------------------------------------------

const LEGACY_CHAT_GROUP_STORAGE_KEY = 'vibeide.chatEditorGroupId';

class LegacyChatGroupCleanupContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeide.legacyChatGroupCleanup';

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		void this.run();
	}

	private async run(): Promise<void> {
		await this.editorGroupsService.whenRestored;
		const egs = this.editorGroupsService;
		const closeIfEmptyLocked = (group: { isLocked: boolean; count: number; lock(locked: boolean): void }) => {
			if (!group) { return; }
			if (group.isLocked) { group.lock(false); } // unlock regardless
			if (group.count === 0 && egs.groups.length > 1) { egs.removeGroup(group as never); } // close dead empty panel
		};
		const storedId = this.storageService.getNumber(LEGACY_CHAT_GROUP_STORAGE_KEY, StorageScope.WORKSPACE);
		if (storedId !== undefined) {
			const g = egs.getGroup(storedId);
			if (g) { closeIfEmptyLocked(g); }
			this.storageService.remove(LEGACY_CHAT_GROUP_STORAGE_KEY, StorageScope.WORKSPACE);
		}
		// Belt-and-suspenders: any other empty locked group is a leftover of the old chat lockdown.
		for (const g of [...egs.groups]) { if (g.isLocked && g.count === 0) { closeIfEmptyLocked(g); } }
	}
}

registerWorkbenchContribution2(
	LegacyChatGroupCleanupContribution.ID,
	LegacyChatGroupCleanupContribution,
	WorkbenchPhase.AfterRestored,
);

// ---------------------------------------------------------------------------
// Chat fullscreen modes (toggled via icons in the chat composer):
//   "maximize" — hide primary sidebar + bottom panel to give the chat view room.
//   "zen"     — same + hide activity bar + collapse landing chrome (body marker).
// The chat lives in the AuxiliaryBar now, so — unlike the old editor-based version — we MUST NOT
// hide the auxiliary bar (that would hide the chat itself). Modes are mutually exclusive; clicking
// the active mode exits to "off". State is module-level (single window).
// ---------------------------------------------------------------------------

type ChatFullscreenMode = 'off' | 'maximize' | 'zen';
let _chatFullscreenMode: ChatFullscreenMode = 'off';
let _saved: { sidebar?: boolean; panel?: boolean; activitybar?: boolean } = {};

function applyChatFullscreenMode(target: ChatFullscreenMode, accessor: ServicesAccessor): void {
	if (target === _chatFullscreenMode) { return; }

	const layoutService = accessor.get(IWorkbenchLayoutService);
	const wasOff = _chatFullscreenMode === 'off';
	const willBeOff = target === 'off';

	// Capture original visibility on the first transition out of "off".
	if (wasOff) {
		_saved = {
			sidebar: layoutService.isVisible(Parts.SIDEBAR_PART),
			panel: layoutService.isVisible(Parts.PANEL_PART),
			activitybar: layoutService.isVisible(Parts.ACTIVITYBAR_PART),
		};
	}

	// Hide sidebar + panel entering fullscreen; restore them on exit. Auxiliary bar (chat) stays.
	if (wasOff && !willBeOff) {
		if (_saved.sidebar) { layoutService.setPartHidden(true, Parts.SIDEBAR_PART); }
		if (_saved.panel) { layoutService.setPartHidden(true, Parts.PANEL_PART); }
	}
	if (!wasOff && willBeOff) {
		if (_saved.sidebar) { layoutService.setPartHidden(false, Parts.SIDEBAR_PART); }
		if (_saved.panel) { layoutService.setPartHidden(false, Parts.PANEL_PART); }
	}

	// Activity bar: hidden ONLY in zen mode; re-shown when switching back to maximize / off.
	const wantsActivityHidden = target === 'zen' && !!_saved.activitybar;
	if (wantsActivityHidden && layoutService.isVisible(Parts.ACTIVITYBAR_PART)) {
		layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART);
	} else if (!wantsActivityHidden && _saved.activitybar && !layoutService.isVisible(Parts.ACTIVITYBAR_PART)) {
		layoutService.setPartHidden(false, Parts.ACTIVITYBAR_PART);
	}

	// Body marker: lets vibeide.css collapse landing-page chrome (model chip, quick actions, past
	// chats / suggestions) so only the input + token line remain visible in zen mode.
	mainWindow.document.body.classList.toggle('vibeide-chat-zen', target === 'zen');

	_chatFullscreenMode = target;
}

const VIBEIDE_CHAT_TOGGLE_MAXIMIZE_CMD = 'vibeide.chat.toggleMaximize';
const VIBEIDE_CHAT_TOGGLE_ZEN_CMD = 'vibeide.chat.toggleZen';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_CHAT_TOGGLE_MAXIMIZE_CMD,
			title: nls.localize2('vibeChatToggleMaximize', 'VibeIDE: Chat Maximize'),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		applyChatFullscreenMode(_chatFullscreenMode === 'maximize' ? 'off' : 'maximize', accessor);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_CHAT_TOGGLE_ZEN_CMD,
			title: nls.localize2('vibeChatToggleZen', 'VibeIDE: Chat Zen Mode'),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		applyChatFullscreenMode(_chatFullscreenMode === 'zen' ? 'off' : 'zen', accessor);
	}
});
