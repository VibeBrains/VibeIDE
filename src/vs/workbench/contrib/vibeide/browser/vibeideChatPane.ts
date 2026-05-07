/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import * as nls from '../../../../nls.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup, IEditorGroupsService, GroupDirection } from '../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IContextKeyService, IContextKey, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { VIBEIDE_OPEN_CHAT_EDITOR_CMD } from './actionIDs.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

import { mountSidebar } from './react/out/sidebar-tsx/index.js';

// ---------------------------------------------------------------------------
// Chat editor group tracking
// ---------------------------------------------------------------------------

const CHAT_GROUP_STORAGE_KEY = 'vibeide.chatEditorGroupId';

/** Context key: true when a VibeIDE chat editor group is alive in the current window. */
export const VIBEIDE_HAS_CHAT_GROUP_CTX = new RawContextKey<boolean>('vibeide.hasChatGroup', false);

// In-session fast path — resets on window reload.
let _chatEditorGroupId: number | undefined;
let _hasChatGroupCtxKey: IContextKey<boolean> | undefined;
// Keeps the onDidRemoveGroup listener alive for the entire renderer session.
let _groupListenerDisposable: IDisposable | undefined;

function setupGroupRemovalListener(
	editorGroupsService: IEditorGroupsService,
	storageService: IStorageService,
): void {
	if (_groupListenerDisposable) { return; }

	_groupListenerDisposable = editorGroupsService.onDidRemoveGroup(group => {
		if (group.id === _chatEditorGroupId) {
			_chatEditorGroupId = undefined;
			storageService.remove(CHAT_GROUP_STORAGE_KEY, StorageScope.WORKSPACE);
			_hasChatGroupCtxKey?.set(false);
		}
	});
}

function findExistingChatGroup(
	editorGroupsService: IEditorGroupsService,
	storageService: IStorageService,
): IEditorGroup | undefined {
	// 1. In-session module cache (fastest path).
	if (_chatEditorGroupId !== undefined) {
		const group = editorGroupsService.getGroup(_chatEditorGroupId);
		if (group) { return group; }
		_chatEditorGroupId = undefined;
	}

	// 2. Workspace-persisted ID — survives window reload when editors are restored.
	const storedId = storageService.getNumber(CHAT_GROUP_STORAGE_KEY, StorageScope.WORKSPACE);
	if (storedId !== undefined) {
		const group = editorGroupsService.getGroup(storedId);
		if (group) {
			const hasChatEditor = group.editors.some(
				e => e.resource?.toString() === VibeChatEditorInput.RESOURCE.toString()
			);
			if (hasChatEditor) {
				_chatEditorGroupId = storedId;
				return group;
			}
		}
		// Stored ID is stale — remove it.
		storageService.remove(CHAT_GROUP_STORAGE_KEY, StorageScope.WORKSPACE);
	}

	// 3. Full scan fallback — covers edge cases where storage drifted from reality.
	for (const group of editorGroupsService.groups) {
		const hasChatEditor = group.editors.some(
			e => e.resource?.toString() === VibeChatEditorInput.RESOURCE.toString()
		);
		if (hasChatEditor) {
			_chatEditorGroupId = group.id;
			storageService.store(CHAT_GROUP_STORAGE_KEY, group.id, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			return group;
		}
	}
	return undefined;
}

async function openChatInGroup(group: IEditorGroup, instantiationService: IInstantiationService): Promise<void> {
	const existing = group.editors.find(
		e => e.resource?.toString() === VibeChatEditorInput.RESOURCE.toString()
	);
	if (existing) {
		await group.openEditor(existing);
	} else {
		const input = instantiationService.createInstance(VibeChatEditorInput);
		await group.openEditor(input, { pinned: true });
	}
}

export async function openVibeChatEditor(accessor: ServicesAccessor): Promise<void> {
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const instantiationService = accessor.get(IInstantiationService);
	const storageService = accessor.get(IStorageService);
	const contextKeyService = accessor.get(IContextKeyService);

	// Initialize context key and removal listener once per renderer session.
	if (!_hasChatGroupCtxKey) {
		_hasChatGroupCtxKey = VIBEIDE_HAS_CHAT_GROUP_CTX.bindTo(contextKeyService);
	}
	setupGroupRemovalListener(editorGroupsService, storageService);

	const existingGroup = findExistingChatGroup(editorGroupsService, storageService);
	if (existingGroup) {
		await openChatInGroup(existingGroup, instantiationService);
		_hasChatGroupCtxKey.set(true);
		return;
	}

	// No chat group — create one to the right of the active group.
	const activeGroup = editorGroupsService.activeGroup;
	const rightGroup = editorGroupsService.addGroup(activeGroup, GroupDirection.RIGHT);
	_chatEditorGroupId = rightGroup.id;
	storageService.store(CHAT_GROUP_STORAGE_KEY, rightGroup.id, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	_hasChatGroupCtxKey.set(true);
	await openChatInGroup(rightGroup, instantiationService);
}

// ---------------------------------------------------------------------------
// VibeChatEditorInput
// ---------------------------------------------------------------------------

export class VibeChatEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.vibe.chat';

	static readonly RESOURCE = URI.from({ scheme: 'vibe', path: 'chat' });

	readonly resource = VibeChatEditorInput.RESOURCE;

	constructor() {
		super();
	}

	override get typeId(): string {
		return VibeChatEditorInput.ID;
	}

	override getName(): string {
		return nls.localize('vibeChatInputName', 'Chat');
	}

	override getIcon() {
		return Codicon.commentDiscussion;
	}

	override matches(other: EditorInput): boolean {
		return other instanceof VibeChatEditorInput;
	}
}

// ---------------------------------------------------------------------------
// VibeChatEditorPane
// ---------------------------------------------------------------------------

class VibeChatEditorPane extends EditorPane {

	static readonly ID = 'workbench.pane.vibe.chat';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(VibeChatEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.style.height = '100%';
		parent.style.width = '100%';

		// Walk up the DOM to find the editor-group-container and stamp a data-attribute on it.
		// CSS in vibe-neon.css targets [data-vibeide-chat-group] via CSS custom properties
		// (--vscode-vibeide-chatGroup-*) so the marker is theme-aware without hardcoded colors.
		let groupContainer: HTMLElement | null = parent.parentElement;
		while (groupContainer && !groupContainer.classList.contains('editor-group-container')) {
			groupContainer = groupContainer.parentElement;
		}
		if (groupContainer) {
			groupContainer.setAttribute('data-vibeide-chat-group', 'true');
			this._register(toDisposable(() => (groupContainer as HTMLElement).removeAttribute('data-vibeide-chat-group')));
		}

		const chatElt = document.createElement('div');
		chatElt.style.height = '100%';
		chatElt.style.width = '100%';
		parent.appendChild(chatElt);

		this.instantiationService.invokeFunction(accessor => {
			const disposeFn = mountSidebar(chatElt, accessor)?.dispose;
			this._register(toDisposable(() => disposeFn?.()));
		});
	}

	layout(_dimension: Dimension): void { /* handled by flex/percent CSS */ }

	override get minimumWidth() { return 300; }
}

// ---------------------------------------------------------------------------
// Startup cleanup: close stale empty chat group left by session restore.
// VS Code persists the editor-group layout but cannot deserialize
// VibeChatEditorInput (no serializer registered), so it restores the group
// as empty.  This contribution removes it right after restore so the user
// always starts with a single editor panel.
// ---------------------------------------------------------------------------

class ChatEditorGroupCleanupContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeide.chatGroupCleanup';

	constructor(
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@IStorageService storageService: IStorageService,
	) {
		const storedId = storageService.getNumber(CHAT_GROUP_STORAGE_KEY, StorageScope.WORKSPACE);
		if (storedId === undefined) { return; }

		const group = editorGroupsService.getGroup(storedId);
		if (!group) {
			storageService.remove(CHAT_GROUP_STORAGE_KEY, StorageScope.WORKSPACE);
			return;
		}

		const hasChatEditor = group.editors.some(
			e => e.resource?.toString() === VibeChatEditorInput.RESOURCE.toString()
		);
		if (!hasChatEditor) {
			// Group was restored empty — chat editor failed to deserialize.
			storageService.remove(CHAT_GROUP_STORAGE_KEY, StorageScope.WORKSPACE);
			if (editorGroupsService.count > 1) {
				editorGroupsService.removeGroup(group);
			}
		}
	}
}

registerWorkbenchContribution2(
	ChatEditorGroupCleanupContribution.ID,
	ChatEditorGroupCleanupContribution,
	WorkbenchPhase.AfterRestored,
);

// ---------------------------------------------------------------------------
// Register editor pane
// ---------------------------------------------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibeChatEditorPane, VibeChatEditorPane.ID, nls.localize('vibeChatPaneLabel', 'VibeIDE Chat Pane')),
	[new SyncDescriptor(VibeChatEditorInput)],
);

// ---------------------------------------------------------------------------
// Register vibeide.chat.open command
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_OPEN_CHAT_EDITOR_CMD,
			title: nls.localize2('vibeOpenChatEditor', 'VibeIDE: Open Chat'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await openVibeChatEditor(accessor);
	}
});
