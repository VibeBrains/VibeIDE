/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import * as nls from '../../../../nls.js';
import { EditorExtensions, GroupModelChangeKind, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
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
import { VIBEIDE_NEW_CHAT_CMD, VIBEIDE_OPEN_CHAT_EDITOR_CMD } from './actionIDs.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

import { mountSidebar } from './react/out/sidebar-tsx/index.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IChatThreadService } from './chatThreadService.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const CHAT_MAX_OPEN_TABS_CONFIG_KEY = 'vibeide.chat.maxOpenTabs';
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		[CHAT_MAX_OPEN_TABS_CONFIG_KEY]: {
			type: 'number',
			default: 5,
			minimum: 1,
			description: nls.localize('vibeide.chat.maxOpenTabs', 'Максимальное число чат-вкладок, которые могут быть открыты одновременно в группе чатов. Мягкий лимит — увеличьте, если нужно больше параллельных чатов.'),
		},
	},
});

function getMaxOpenChatTabs(configurationService: IConfigurationService): number {
	const v = configurationService.getValue<number>(CHAT_MAX_OPEN_TABS_CONFIG_KEY);
	const n = typeof v === 'number' ? Math.floor(v) : 5;
	return Math.max(1, n);
}

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
// Per-chat-group lockdown listener: bounces foreign editors out of the chat group.
let _chatGroupLockdownDisposable: IDisposable | undefined;

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
			_chatGroupLockdownDisposable?.dispose();
			_chatGroupLockdownDisposable = undefined;
		}
	});
}

function moveForeignEditorOut(
	editor: EditorInput,
	fromGroup: IEditorGroup,
	editorGroupsService: IEditorGroupsService,
): void {
	let target = editorGroupsService.findGroup({ direction: GroupDirection.LEFT }, fromGroup);
	if (!target) {
		target = editorGroupsService.groups.find(g => g.id !== fromGroup.id);
	}
	if (!target) {
		target = editorGroupsService.addGroup(fromGroup, GroupDirection.LEFT);
	}
	fromGroup.moveEditor(editor, target);
}

function setupChatGroupLockdown(
	group: IEditorGroup,
	editorGroupsService: IEditorGroupsService,
): void {
	_chatGroupLockdownDisposable?.dispose();

	// Lock the group so VS Code's default editor open routing skips it for non-chat editors.
	// VibeChatEditorInput still opens here because isGroupLockedForEditor() lets locked groups receive editors that match already-open ones.
	if (!group.isLocked) {
		group.lock(true);
	}

	// Evict already-present foreign editors (covers session restore that landed alien tabs in the chat group).
	for (const editor of group.editors.filter(e => !(e instanceof VibeChatEditorInput))) {
		moveForeignEditorOut(editor, group, editorGroupsService);
	}

	// If the active editor is foreign (just evicted) or absent, fall back to the first chat tab so the pane shows chat content instead of stale file content.
	// IMPORTANT: do NOT switch when the active editor is already a chat tab — otherwise this stomps on the tab the user (or openOrFocusChatInGroup) just opened, making "+" appear broken.
	if (!(group.activeEditor instanceof VibeChatEditorInput)) {
		const chatEditor = group.editors.find(e => e instanceof VibeChatEditorInput);
		if (chatEditor) {
			void group.openEditor(chatEditor);
		}
	}

	_chatGroupLockdownDisposable = group.onDidModelChange(e => {
		if (e.kind !== GroupModelChangeKind.EDITOR_OPEN) { return; }
		const opened = e.editor;
		if (!opened || opened instanceof VibeChatEditorInput) { return; }
		moveForeignEditorOut(opened, group, editorGroupsService);
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
			const hasChatEditor = group.editors.some(e => e instanceof VibeChatEditorInput);
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
		const hasChatEditor = group.editors.some(e => e instanceof VibeChatEditorInput);
		if (hasChatEditor) {
			_chatEditorGroupId = group.id;
			storageService.store(CHAT_GROUP_STORAGE_KEY, group.id, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			return group;
		}
	}
	return undefined;
}

function countChatTabs(group: IEditorGroup): number {
	return group.editors.reduce((acc, e) => acc + (e instanceof VibeChatEditorInput ? 1 : 0), 0);
}

async function openOrFocusChatInGroup(
	group: IEditorGroup,
	options: OpenChatOptions,
	chatThreadService: IChatThreadService,
	notificationService: INotificationService,
	configurationService: IConfigurationService,
): Promise<void> {
	// Specific chatId requested → focus it if open, otherwise create.
	if (options.chatId) {
		const existing = group.editors.find(e => e instanceof VibeChatEditorInput && e.chatId === options.chatId) as VibeChatEditorInput | undefined;
		if (existing) {
			await group.openEditor(existing);
			return;
		}
		const input = new VibeChatEditorInput(options.chatId);
		await group.openEditor(input, { pinned: true });
		return;
	}

	// "New chat" requested.
	if (options.newChat) {
		const max = getMaxOpenChatTabs(configurationService);
		if (countChatTabs(group) >= max) {
			notificationService.warn(nls.localize('vibeide.chat.maxOpenTabs.reached', "Достигнут лимит чат-вкладок ({0}/{0}). Увеличьте «vibeide.chat.maxOpenTabs» в настройках, чтобы открывать больше.", max));
			// Focus active chat (or any chat) so the user lands somewhere reasonable.
			const fallback = (group.activeEditor instanceof VibeChatEditorInput ? group.activeEditor : group.editors.find(e => e instanceof VibeChatEditorInput)) as VibeChatEditorInput | undefined;
			if (fallback) { await group.openEditor(fallback); }
			return;
		}
		// Force a brand-new thread per click so "+" always yields a new tab — openNewThread()'s empty-thread reuse would otherwise refocus an existing empty tab and silently skip creation.
		const newThreadId = chatThreadService.forceCreateNewThread();
		const input = new VibeChatEditorInput(newThreadId);
		await group.openEditor(input, { pinned: true });
		return;
	}

	// Default: focus existing chat (active or first), or create the very first one.
	const chats = group.editors.filter((e): e is VibeChatEditorInput => e instanceof VibeChatEditorInput);
	if (chats.length > 0) {
		const target = (group.activeEditor instanceof VibeChatEditorInput ? group.activeEditor : chats[0]) as VibeChatEditorInput;
		await group.openEditor(target);
		return;
	}
	// No chats yet — bootstrap the first tab from the current thread (or a freshly-opened one).
	let chatId = chatThreadService.state.currentThreadId;
	if (!chatId) {
		chatThreadService.openNewThread();
		chatId = chatThreadService.state.currentThreadId;
	}
	const input = new VibeChatEditorInput(chatId);
	await group.openEditor(input, { pinned: true });
}

export interface OpenChatOptions {
	/** Open a brand-new chat tab (subject to `vibeide.chat.maxOpenTabs`). */
	newChat?: boolean;
	/** Focus this exact chat tab; create if missing. Wins over `newChat`. */
	chatId?: string;
}

export async function openVibeChatEditor(instantiationService: IInstantiationService, options: OpenChatOptions = {}): Promise<void> {
	// Resolve services through invokeFunction so we get a fresh accessor — the caller's ServicesAccessor may already be invalidated by an await before reaching us.
	const services = instantiationService.invokeFunction(accessor => ({
		editorGroupsService: accessor.get(IEditorGroupsService),
		editorService: accessor.get(IEditorService),
		storageService: accessor.get(IStorageService),
		contextKeyService: accessor.get(IContextKeyService),
		chatThreadService: accessor.get(IChatThreadService),
		notificationService: accessor.get(INotificationService),
		configurationService: accessor.get(IConfigurationService),
	}));
	const { editorGroupsService, editorService, storageService, contextKeyService, chatThreadService, notificationService, configurationService } = services;

	// Initialize context key and removal listener once per renderer session.
	if (!_hasChatGroupCtxKey) {
		_hasChatGroupCtxKey = VIBEIDE_HAS_CHAT_GROUP_CTX.bindTo(contextKeyService);
	}
	setupGroupRemovalListener(editorGroupsService, storageService);

	const existingGroup = findExistingChatGroup(editorGroupsService, storageService);
	if (existingGroup) {
		await openOrFocusChatInGroup(existingGroup, options, chatThreadService, notificationService, configurationService);
		editorGroupsService.activateGroup(existingGroup);
		existingGroup.focus();
		setupChatGroupLockdown(existingGroup, editorGroupsService);
		_hasChatGroupCtxKey.set(true);
		return;
	}

	// No chat group — open via IEditorService.openEditor(..., SIDE_GROUP). This is the canonical VS Code path: it creates the group, lays it out, activates it, and focuses the new editor in one atomic step. Manual addGroup + openEditor leaves the new group unactivated when the click originates from the auxiliary bar (sidebar "+"), which made the chat tab invisible on a cold start.
	let input: VibeChatEditorInput;
	if (options.chatId) {
		input = new VibeChatEditorInput(options.chatId);
	} else if (options.newChat) {
		const newThreadId = chatThreadService.forceCreateNewThread();
		input = new VibeChatEditorInput(newThreadId);
	} else {
		let chatId = chatThreadService.state.currentThreadId;
		if (!chatId) { chatId = chatThreadService.forceCreateNewThread(); }
		input = new VibeChatEditorInput(chatId);
	}
	const pane = await editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
	const newGroup = pane?.group;
	if (newGroup) {
		_chatEditorGroupId = newGroup.id;
		storageService.store(CHAT_GROUP_STORAGE_KEY, newGroup.id, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		_hasChatGroupCtxKey.set(true);
		setupChatGroupLockdown(newGroup, editorGroupsService);
	}
}

// ---------------------------------------------------------------------------
// VibeChatEditorInput
// ---------------------------------------------------------------------------

export class VibeChatEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.vibe.chat';

	/** Each tab carries a unique id so VS Code treats sibling chat tabs as distinct editors (matches() compares by chatId). */
	readonly chatId: string;
	readonly resource: URI;

	constructor(chatId: string = generateUuid()) {
		super();
		this.chatId = chatId;
		// vibe:chat/<chatId> — unique per tab so VS Code's editor model keeps sibling chats apart.
		this.resource = URI.from({ scheme: 'vibe', path: `chat/${chatId}` });
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
		return other instanceof VibeChatEditorInput && other.chatId === this.chatId;
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
		@IFileService private readonly fileService: IFileService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
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

		// Capture-phase drop intercept: file drags from the explorer become chat staging selections instead of opening as editors.
		// IMPORTANT: VS Code's EditorDropTarget creates a DropOverlay div appended directly to groupView.element during drag and listens on it.
		// That overlay is a SIBLING/descendant of groupContainer but NOT of our `parent`, so capture-phase on `parent` is never reached.
		// Listener must be on groupContainer (the .editor-group-container) — capture phase here fires before the overlay's bubble-phase handler.
		// Internal editor tab drags ('application/vnd.code.editor') are skipped — they fall through to the existing onDidModelChange lockdown which moves them to a sibling group.
		// Image/PDF blob drops without text/uri-list (e.g. dropping a buffered image into the React composer) are also skipped — the React composer's onDrop handles them.
		const isExternalFileDrag = (e: DragEvent): boolean => {
			const t = e.dataTransfer;
			if (!t) { return false; }
			if (t.types.includes('application/vnd.code.editor')) { return false; }
			return t.types.includes('text/uri-list');
		};
		const setDragOverFlag = (on: boolean) => {
			if (!groupContainer) { return; }
			if (on) { groupContainer.setAttribute('data-vibeide-chat-drag-over', 'true'); }
			else { groupContainer.removeAttribute('data-vibeide-chat-drag-over'); }
		};
		const onDragEnterCapture = (e: DragEvent) => {
			if (!isExternalFileDrag(e)) { return; }
			e.preventDefault();
			e.stopPropagation();
			setDragOverFlag(true);
		};
		const onDragLeaveCapture = (e: DragEvent) => {
			if (!isExternalFileDrag(e)) { return; }
			// dragleave fires for every descendant transition — only clear the flag when the cursor truly leaves the group container.
			const related = e.relatedTarget as Node | null;
			if (related && groupContainer && groupContainer.contains(related)) { return; }
			setDragOverFlag(false);
		};
		const onDragOverCapture = (e: DragEvent) => {
			if (!isExternalFileDrag(e)) { return; }
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
		};
		const onDropCapture = (e: DragEvent) => {
			if (!isExternalFileDrag(e)) { return; }
			setDragOverFlag(false);
			const raw = e.dataTransfer?.getData('text/uri-list') ?? '';
			e.preventDefault();
			e.stopPropagation();

			const uris: URI[] = [];
			for (const line of raw.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('#')) { continue; }
				try { uris.push(URI.parse(trimmed)); } catch { /* skip malformed */ }
			}
			if (uris.length === 0) { return; }

			void (async () => {
				for (const uri of uris) {
					try {
						const stat = await this.fileService.stat(uri);
						if (stat.isDirectory) {
							this.chatThreadService.addNewStagingSelection({ type: 'Folder', uri });
						} else {
							this.chatThreadService.addNewStagingSelection({
								type: 'File',
								uri,
								language: this.languageService.guessLanguageIdByFilepathOrFirstLine(uri) ?? 'plaintext',
								state: { wasAddedAsCurrentFile: false },
							});
						}
					} catch { /* skip unreadable */ }
				}
				await this.chatThreadService.focusCurrentChat();
			})();
		};
		if (groupContainer) {
			const target = groupContainer;
			target.addEventListener('dragenter', onDragEnterCapture, true);
			target.addEventListener('dragleave', onDragLeaveCapture, true);
			target.addEventListener('dragover', onDragOverCapture, true);
			target.addEventListener('drop', onDropCapture, true);
			this._register(toDisposable(() => {
				target.removeEventListener('dragenter', onDragEnterCapture, true);
				target.removeEventListener('dragleave', onDragLeaveCapture, true);
				target.removeEventListener('dragover', onDragOverCapture, true);
				target.removeEventListener('drop', onDropCapture, true);
				target.removeAttribute('data-vibeide-chat-drag-over');
			}));
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

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		// Each chat tab carries its own threadId via chatId; switching tabs flips the global "current thread" so the React UI re-renders for the active chat.
		if (input instanceof VibeChatEditorInput) {
			this.chatThreadService.switchToThread(input.chatId);
		}
	}

	layout(_dimension: Dimension): void { /* handled by flex/percent CSS */ }

	override get minimumWidth() { return 300; }
}

// ---------------------------------------------------------------------------
// Startup cleanup / lockdown rebind for the chat editor group.
// With VibeChatEditorInputSerializer registered, VS Code restores all chat
// tabs and the previously-active one on its own. This contribution now
// handles two residual cases:
//  1. Migration from older builds (no serializer) where the persisted group
//     comes back empty — repopulate with a single fallback chat so the
//     layout still matches user expectation.
//  2. Re-attach the in-memory chat-group id and lockdown listener to the
//     restored group (module-level state was lost across reload).
// ---------------------------------------------------------------------------

class ChatEditorGroupCleanupContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeide.chatGroupCleanup';

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly storageService: IStorageService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
	) {
		void this.run();
	}

	private async run(): Promise<void> {
		// AfterRestored fires once LifecyclePhase.Restored is reached, but visible editors inside groups may still be resolving.
		// whenRestored guarantees the layout AND the active editors are fully materialized — only then is it safe to read group.editors.
		await this.editorGroupsService.whenRestored;

		const storedId = this.storageService.getNumber(CHAT_GROUP_STORAGE_KEY, StorageScope.WORKSPACE);
		if (storedId === undefined) { return; }

		const group = this.editorGroupsService.getGroup(storedId);
		if (!group) {
			this.storageService.remove(CHAT_GROUP_STORAGE_KEY, StorageScope.WORKSPACE);
			return;
		}

		const hasChatEditor = group.editors.some(e => e instanceof VibeChatEditorInput);
		if (!hasChatEditor) {
			// Group restored empty — happens for layouts saved before VibeChatEditorInputSerializer existed (one-time migration), or when every persisted chatId pointed at a deleted thread.
			// Repopulate with a single chat tab bound to the current thread so the user's previous "two-panel" layout is preserved instead of leaving a blank panel.
			let chatId = this.chatThreadService.state.currentThreadId;
			if (!chatId) { chatId = this.chatThreadService.forceCreateNewThread(); }
			const input = new VibeChatEditorInput(chatId);
			void group.openEditor(input, { pinned: true });
		}

		// Re-attach module-level chat-group state and lockdown listener (lost across window reload).
		_chatEditorGroupId = group.id;
		setupGroupRemovalListener(this.editorGroupsService, this.storageService);
		setupChatGroupLockdown(group, this.editorGroupsService);
	}
}

// AfterRestored: runs once editor groups are materialized, then the contribution awaits whenRestored before touching them.
// Earlier phases (BlockRestore) are unsafe here — getGroup(storedId) returns undefined and the fallback never fires.
registerWorkbenchContribution2(
	ChatEditorGroupCleanupContribution.ID,
	ChatEditorGroupCleanupContribution,
	WorkbenchPhase.AfterRestored,
);

// ---------------------------------------------------------------------------
// Editor input serializer
// Persists open chat tabs across window reloads. Without this, VS Code
// restores the editor group layout but drops VibeChatEditorInput instances,
// leaving an empty second panel that ChatEditorGroupCleanupContribution then
// has to repopulate with a single fallback chat — losing all but one tab.
// ---------------------------------------------------------------------------

interface ISerializedVibeChatEditorInput {
	chatId: string;
}

class VibeChatEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof VibeChatEditorInput;
	}

	serialize(input: VibeChatEditorInput): string {
		const data: ISerializedVibeChatEditorInput = { chatId: input.chatId };
		return JSON.stringify(data);
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		let data: ISerializedVibeChatEditorInput;
		try {
			data = JSON.parse(serializedEditor) as ISerializedVibeChatEditorInput;
		} catch {
			return undefined;
		}
		if (!data || typeof data.chatId !== 'string' || !data.chatId) {
			return undefined;
		}
		// Drop tabs whose underlying thread no longer exists (deleted from another window).
		// Returning undefined makes VS Code skip this editor; the group will only survive if any sibling tab deserializes.
		const chatThreadService = instantiationService.invokeFunction(accessor => accessor.get(IChatThreadService));
		if (!chatThreadService.state.allThreads[data.chatId]) {
			return undefined;
		}
		return new VibeChatEditorInput(data.chatId);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	VibeChatEditorInput.ID,
	VibeChatEditorInputSerializer,
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
		await openVibeChatEditor(accessor.get(IInstantiationService));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_NEW_CHAT_CMD,
			title: nls.localize2('vibeNewChat', 'VibeIDE: New Chat Tab'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await openVibeChatEditor(accessor.get(IInstantiationService), { newChat: true });
	}
});
