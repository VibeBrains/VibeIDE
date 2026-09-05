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
import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { VIBEIDE_NEW_CHAT_CMD, VIBEIDE_OPEN_CHAT_EDITOR_CMD } from './actionIDs.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { VIBEIDE_CHAT_VIEW_ID } from './sidebarPane.js';
import { IChatThreadService } from './chatThreadService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

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
//   "maximize" — hide primary sidebar and bottom panel, and MAXIMIZE the auxiliary bar so the chat
//                 actually takes the freed width.
//   "zen"     — same + hide activity bar + collapse landing chrome (body marker).
//
// Widening the chat is the whole point since it moved out of the editor area: back when the chat WAS
// an editor tab, «maximize» only had to clear what surrounded it. Now the editors keep the middle of
// the window, and hiding them by hand freed the space without giving it to anyone — measured on a
// live window: the editor area went 1040 → 0 and the chat stayed at 489.
//
// So the auxiliary bar is maximized through the workbench's own mechanism, which both collapses the
// editor area and hands its width over. The auxiliary bar itself is never hidden — that is where the
// chat is — and nothing is maximized when it is not visible: the chat is then somewhere else, and
// this would be rearranging a window around something that is not there.
//
// Modes are mutually exclusive; clicking the active mode exits to "off". State is module-level
// (single window).
// ---------------------------------------------------------------------------

type ChatFullscreenMode = 'off' | 'maximize' | 'zen';
let _chatFullscreenMode: ChatFullscreenMode = 'off';
let _saved: { sidebar?: boolean; panel?: boolean; activitybar?: boolean; auxiliaryMaximized?: boolean } = {};

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
			// Maximizing only makes sense while the chat is in the auxiliary bar.
			auxiliaryMaximized: layoutService.isVisible(Parts.AUXILIARYBAR_PART),
		};
	}

	// Hide sidebar + panel entering fullscreen; restore them on exit. Auxiliary bar (chat) stays.
	if (wasOff && !willBeOff) {
		if (_saved.sidebar) { layoutService.setPartHidden(true, Parts.SIDEBAR_PART); }
		if (_saved.panel) { layoutService.setPartHidden(true, Parts.PANEL_PART); }
		if (_saved.auxiliaryMaximized) { layoutService.setAuxiliaryBarMaximized(true); }
	}
	if (!wasOff && willBeOff) {
		if (_saved.sidebar) { layoutService.setPartHidden(false, Parts.SIDEBAR_PART); }
		if (_saved.panel) { layoutService.setPartHidden(false, Parts.PANEL_PART); }
		// Back to the ordinary split; the editor area returns with it.
		if (_saved.auxiliaryMaximized) { layoutService.setAuxiliaryBarMaximized(false); }
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
	// The other marker keeps the CONTENT in a column instead of stretching it across the window:
	// a chat 1800 pixels wide cannot be read — the line runs past where the eye can follow, and the
	// start of the next one is lost. Both modes give the panel the width; neither gives it to the text.
	mainWindow.document.body.classList.toggle('vibeide-chat-wide', !willBeOff);
	_storage = accessor.get(IStorageService);
	applyStoredColumnWidth();
	updateColumnResizer(accessor.get(IWorkbenchLayoutService), !willBeOff);

	_chatFullscreenMode = target;
}

/** Настройка ширины колонки: одна на оба режима, помнится между сеансами. */
const CHAT_COLUMN_WIDTH_KEY = 'vibeide.chat.wideColumnWidth';
const CHAT_COLUMN_DEFAULT = 900;
/** Bounds. Narrower stops being a chat, wider stops being readable — the reason the column exists. */
const CHAT_COLUMN_MIN = 480;
const CHAT_COLUMN_MAX = 1600;

let _resizer: HTMLElement | undefined;
let _resizerListeners: IDisposable[] = [];

/**
 * Services are captured ONCE, when the mode is switched.
 *
 * `ServicesAccessor` is only valid inside the command that received it. Keeping it in a closure and
 * asking it for a service during a later drag throws — which is exactly what happened: the handle
 * appeared, the pointer moved, and nothing changed, because the first line of the handler failed.
 */
let _storage: IStorageService | undefined;

function storedColumnWidth(): number {
	const stored = _storage?.getNumber(CHAT_COLUMN_WIDTH_KEY, StorageScope.PROFILE, CHAT_COLUMN_DEFAULT) ?? CHAT_COLUMN_DEFAULT;
	return Math.min(CHAT_COLUMN_MAX, Math.max(CHAT_COLUMN_MIN, stored));
}

function applyStoredColumnWidth(): void {
	mainWindow.document.body.style.setProperty('--vibeide-chat-wide-width', `${storedColumnWidth()}px`);
}

/**
 * Полоса перетаскивания у правого края колонки.
 *
 * Placed over the auxiliary bar rather than inside the React tree: the modes are switched from here,
 * the column is a layout decision made here, and threading a resize handle through the chat's own
 * markup would put window layout inside a component that knows nothing about it.
 */
function updateColumnResizer(layoutService: IWorkbenchLayoutService, active: boolean): void {
	for (const listener of _resizerListeners) { listener.dispose(); }
	_resizerListeners = [];
	if (!active) {
		_resizer?.remove();
		_resizer = undefined;
		return;
	}

	const container = layoutService.getContainer(mainWindow, Parts.AUXILIARYBAR_PART);
	if (!container) {
		return;
	}
	const handle = _resizer ?? mainWindow.document.createElement('div');
	handle.className = 'vibeide-chat-wide-resizer';
	if (!handle.isConnected) {
		container.appendChild(handle);
	}
	_resizer = handle;

	const place = () => {
		// Right edge of the centred column, in the panel's own coordinates.
		const width = storedColumnWidth();
		const panelWidth = container.getBoundingClientRect().width;
		handle.style.left = `${Math.round((panelWidth + Math.min(width, panelWidth)) / 2) - 5}px`;
	};
	place();

	_resizerListeners.push(addDisposableListener(handle, EventType.MOUSE_DOWN, (event: MouseEvent) => {
		event.preventDefault();
		handle.classList.add('vibeide-chat-wide-resizing');
		const startX = event.clientX;
		const startWidth = storedColumnWidth();

		const move = (moveEvent: MouseEvent) => {
			// Dragging right widens the column by twice the travel: it is centred, so both edges move.
			const next = Math.min(CHAT_COLUMN_MAX, Math.max(CHAT_COLUMN_MIN, startWidth + (moveEvent.clientX - startX) * 2));
			mainWindow.document.body.style.setProperty('--vibeide-chat-wide-width', `${Math.round(next)}px`);
			const panelWidth = container.getBoundingClientRect().width;
			handle.style.left = `${Math.round((panelWidth + Math.min(next, panelWidth)) / 2) - 5}px`;
		};
		const up = () => {
			handle.classList.remove('vibeide-chat-wide-resizing');
			const applied = parseInt(mainWindow.document.body.style.getPropertyValue('--vibeide-chat-wide-width'), 10);
			if (Number.isFinite(applied)) {
				// Stored on release, not on every pointer move: a drag would otherwise write hundreds
				// of times for one adjustment.
				_storage?.store(CHAT_COLUMN_WIDTH_KEY, applied, StorageScope.PROFILE, StorageTarget.USER);
			}
			for (const listener of dragListeners) { listener.dispose(); }
		};
		// Listened on the window, not on the handle: during a drag the pointer leaves a 10-pixel strip
		// immediately, and a handler bound to the strip stops hearing about the drag it started.
		const dragListeners = [
			addDisposableListener(mainWindow, EventType.MOUSE_MOVE, move),
			addDisposableListener(mainWindow, EventType.MOUSE_UP, up),
		];
		_resizerListeners.push(...dragListeners);
	}));
	_resizerListeners.push(addDisposableListener(mainWindow, EventType.RESIZE, place));
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
