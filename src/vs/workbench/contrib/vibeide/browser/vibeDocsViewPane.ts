/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as DOM from '../../../../base/browser/dom.js';
import { IDragAndDropData } from '../../../../base/browser/dnd.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { ElementsDragAndDropData } from '../../../../base/browser/ui/list/listView.js';
import { ITreeNode, IObjectTreeElement, ITreeRenderer, ITreeDragAndDrop, ITreeContextMenuEvent } from '../../../../base/browser/ui/tree/tree.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { InputBox, MessageType } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Schemas } from '../../../../base/common/network.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { dirname, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { localize } from '../../../../nls.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { fillEditorsDragData } from '../../../browser/dnd.js';
import {
	VIBE_DOCS_CONTEXT_MENU,
	VIBE_DOCS_DEFAULT_EXT,
	VIBE_DOCS_MARKDOWN_RE,
	VibeDocsClipboardHasContext,
	VibeDocsItemType,
	VibeDocsItemTypeContext,
} from './vibeDocsConstants.js';
import { applyMarkdownExtension, IVibeDocNode, IVibeDocsService, validateDocName } from './vibeDocsService.js';
import { IVibeDocsGraphService } from './vibeDocsGraphService.js';
import { VibeDocsGraphInput, VibeDocsGraphPane } from './vibeDocsGraphEditor.js';

/** Command contributed by `markdown-language-features`; renders a doc instead of showing its source. */
const MARKDOWN_SHOW_PREVIEW_CMD = 'markdown.showPreview';
/** Contributed by the files layer; reached by id so the panel keeps no dependency on it. */
const REVEAL_IN_OS_CMD = 'revealFileInOS';

const $ = DOM.$;
const ROW_TEMPLATE = 'vibeDocs.row';
const MDX_RE = /\.mdx$/i;

/**
 * Identity of the placeholder row that hosts the inline input while a file or folder is being
 * created. A NUL prefix can't collide with a real relative path.
 */
const NEW_NODE_ID = '\u0000vibeDocs.new';

/** The panel only ever shows markdown, so the extension is noise — `.mdx` is marked on the icon instead. */
function displayName(node: IVibeDocNode): string {
	if (node.isDirectory) {
		return node.name;
	}
	const ext = VIBE_DOCS_MARKDOWN_RE.exec(node.name)?.[0];
	return ext ? node.name.slice(0, -ext.length) : node.name;
}

type EditKind = 'newFile' | 'newFolder' | 'rename';

interface IEditContext {
	readonly kind: EditKind;
	/** Row the input renders on: the placeholder for creates, the target's own row for renames. */
	readonly nodeId: string;
	/** Folder the result lands in. */
	readonly parent: URI;
	/** Node of `parent`, or `undefined` at the docs root — tells `_toElements` where to inject the row. */
	readonly parentNodeId: string | undefined;
	readonly target?: IVibeDocNode;
	/** Final names already in `parent`; the target's own name is exempt when renaming. */
	readonly siblings: readonly string[];
	/** Live draft, so a repaint mid-typing doesn't lose what was typed. */
	draft: string;
}

/** The renderer owns the input widget but none of the edit state — the pane does. */
interface IEditHost {
	getEdit(): IEditContext | undefined;
	validate(value: string): string | undefined;
	setDraft(value: string): void;
	accept(value: string): void;
	cancel(): void;
}

interface IRowTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly inputHost: HTMLElement;
	readonly elementDisposables: DisposableStore;
}

class VibeDocsDelegate implements IListVirtualDelegate<IVibeDocNode> {
	getHeight(): number {
		return 22;
	}
	getTemplateId(): string {
		return ROW_TEMPLATE;
	}
}

class VibeDocsRenderer implements ITreeRenderer<IVibeDocNode, void, IRowTemplate> {
	readonly templateId = ROW_TEMPLATE;

	constructor(
		private readonly _host: IEditHost,
		private readonly _contextViewService: IContextViewService,
	) { }

	renderTemplate(container: HTMLElement): IRowTemplate {
		const row = DOM.append(container, $('.vibe-docs-row'));
		const icon = DOM.append(row, $('span.vibe-docs-icon'));
		const label = DOM.append(row, $('span.vibe-docs-label'));
		const inputHost = DOM.append(row, $('.vibe-docs-input-host'));
		return { row, icon, label, inputHost, elementDisposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<IVibeDocNode, void>, _index: number, data: IRowTemplate): void {
		data.elementDisposables.clear();
		DOM.clearNode(data.inputHost);

		const el = node.element;
		const edit = this._host.getEdit();
		const editing = edit?.nodeId === el.id;

		data.icon.className = 'vibe-docs-icon ' + ThemeIcon.asClassName(el.isDirectory ? Codicon.folder : Codicon.markdown);
		data.icon.classList.toggle('is-mdx', !el.isDirectory && MDX_RE.test(el.name));
		data.row.classList.toggle('editing', editing);
		data.label.style.display = editing ? 'none' : '';

		if (!editing) {
			data.label.textContent = displayName(el);
			// The row hides the extension, so keep the real file name reachable on hover.
			data.label.title = el.uri.fsPath || el.uri.toString(true);
			return;
		}
		this._renderInput(data, edit!);
	}

	private _renderInput(data: IRowTemplate, edit: IEditContext): void {
		const input = data.elementDisposables.add(new InputBox(data.inputHost, this._contextViewService, {
			inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: edit.kind === 'rename'
				? localize('vibeDocs.input.rename', "Новое имя")
				: localize('vibeDocs.input.create', "Имя нового элемента"),
			validationOptions: {
				validation: value => {
					const message = this._host.validate(value);
					return message ? { content: message, type: MessageType.ERROR } : null;
				},
			},
		}));
		input.value = edit.draft;

		// The row is mounted mid-repaint, and the list grabs focus back while it settles. Claiming
		// focus a frame later avoids a blur that would cancel the edit before it can be typed into.
		let focused = false;
		data.elementDisposables.add(DOM.scheduleAtNextAnimationFrame(DOM.getWindow(data.row), () => {
			input.focus();
			input.select();
			focused = true;
		}));

		data.elementDisposables.add(input.onDidChange(value => this._host.setDraft(value)));
		data.elementDisposables.add(DOM.addStandardDisposableListener(input.inputElement, DOM.EventType.KEY_DOWN, e => {
			if (e.equals(KeyCode.Enter)) {
				e.stopPropagation();
				if (!this._host.validate(input.value)) {
					this._host.accept(input.value);
				}
			} else if (e.equals(KeyCode.Escape)) {
				e.stopPropagation();
				this._host.cancel();
			}
		}));
		// Clicking away commits a usable name and drops an unusable one, like the Explorer does.
		// Enter/Escape resolve the edit before the blur lands, hence the identity check.
		data.elementDisposables.add(DOM.addDisposableListener(input.inputElement, DOM.EventType.BLUR, () => {
			if (!focused || this._host.getEdit() !== edit) {
				return;
			}
			if (this._host.validate(input.value)) {
				this._host.cancel();
			} else {
				this._host.accept(input.value);
			}
		}));
	}

	disposeElement(_node: ITreeNode<IVibeDocNode, void>, _index: number, data: IRowTemplate): void {
		data.elementDisposables.clear();
	}

	disposeTemplate(data: IRowTemplate): void {
		data.elementDisposables.dispose();
	}
}

/**
 * Drag-out support: hands docs to any resource drop target (chat attachments, editor groups).
 * Nothing drops back into the panel — moving docs around is done through cut/paste.
 */
class VibeDocsDragAndDrop implements ITreeDragAndDrop<IVibeDocNode> {

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) { }

	getDragURI(element: IVibeDocNode): string | null {
		return element.isDirectory || element.id === NEW_NODE_ID ? null : element.uri.toString();
	}

	getDragLabel(elements: IVibeDocNode[]): string | undefined {
		return elements.length === 1 ? displayName(elements[0]) : String(elements.length);
	}

	onDragStart(data: IDragAndDropData, originalEvent: DragEvent): void {
		const elements = (data as ElementsDragAndDropData<IVibeDocNode, IVibeDocNode[]>).elements;
		const resources = elements.filter(e => !e.isDirectory).map(e => e.uri);
		if (resources.length) {
			// Same payload the Explorer produces, which is what resource drop targets read.
			this._instantiationService.invokeFunction(accessor => fillEditorsDragData(accessor, resources, originalEvent));
		}
	}

	onDragOver(): boolean {
		return false;
	}

	drop(): void { }

	dispose(): void { }
}

export class VibeDocsViewPane extends ViewPane implements IEditHost {

	private _tree: WorkbenchObjectTree<IVibeDocNode, void> | undefined;
	private _bodyDom: HTMLElement | undefined;
	private _rosterEmpty = true;
	private _nodes: readonly IVibeDocNode[] = [];

	/** Collapsed rows survive repaints — the tree is rebuilt wholesale on every file change. */
	private readonly _collapsed = new Set<string>();
	private _edit: IEditContext | undefined;
	private _clipboard: { readonly sources: readonly URI[]; readonly move: boolean } | undefined;
	private _revealAfterPaint: URI | undefined;

	private readonly _itemType: IContextKey<VibeDocsItemType>;
	private readonly _clipboardHas: IContextKey<boolean>;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IVibeDocsService private readonly _docs: IVibeDocsService,
		@ICommandService private readonly _commandService: ICommandService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@IEditorService private readonly _editorService: IEditorService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@ILabelService private readonly _labelService: ILabelService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IVibeDocsGraphService private readonly _graphService: IVibeDocsGraphService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._itemType = VibeDocsItemTypeContext.bindTo(this.scopedContextKeyService);
		this._clipboardHas = VibeDocsClipboardHasContext.bindTo(this.scopedContextKeyService);
		this._register(this.onDidChangeViewWelcomeState(() => this._syncRosterHostVisibility()));
	}

	override shouldShowWelcome(): boolean {
		return this._rosterEmpty;
	}

	private _syncRosterHostVisibility(): void {
		if (this._bodyDom) {
			this._bodyDom.style.display = this.shouldShowWelcome() ? 'none' : '';
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._bodyDom = DOM.append(container, $('.vibe-docs-body'));
		this._syncRosterHostVisibility();

		const tree = this.instantiationService.createInstance(
			WorkbenchObjectTree,
			'VibeDocsTree',
			this._bodyDom,
			new VibeDocsDelegate(),
			[new VibeDocsRenderer(this, this._contextViewService)],
			{
				identityProvider: { getId: (e: IVibeDocNode) => e.id },
				accessibilityProvider: this._accessibility(),
				collapseByDefault: false,
				dnd: this.instantiationService.createInstance(VibeDocsDragAndDrop),
			},
		) as WorkbenchObjectTree<IVibeDocNode, void>;
		this._tree = tree;
		this._register(tree);

		// Single-click opens a file; folders toggle (default tree behavior).
		this._register(tree.onDidOpen(e => {
			if (e.element && !e.element.isDirectory && e.element.id !== NEW_NODE_ID) {
				void this._openPreview(e.element.uri);
			}
		}));
		this._register(tree.onDidChangeCollapseState(e => {
			const element = e.node.element;
			if (!element) {
				return;
			}
			if (e.node.collapsed) {
				this._collapsed.add(element.id);
			} else {
				this._collapsed.delete(element.id);
			}
		}));
		this._register(tree.onDidChangeFocus(() => this._syncContextKeys()));
		this._register(tree.onContextMenu(e => this._onContextMenu(e)));
		this._register(this._docs.onDidChangeDocs(() => this._paint()));
		void this._paint();
	}

	private _accessibility(): IListAccessibilityProvider<IVibeDocNode> {
		return {
			getAriaLabel: e => e.id === NEW_NODE_ID ? localize('vibeDocs.aria.new', "Новый элемент") : e.relPath,
			getWidgetAriaLabel: () => localize('vibeDocs.aria.widget', "Документы проекта"),
		};
	}

	private _onContextMenu(e: ITreeContextMenuEvent<IVibeDocNode | null>): void {
		if (this._edit) {
			return; // an inline edit owns the panel until it resolves
		}
		const tree = this._tree;
		if (!tree) {
			return;
		}
		const element = e.element ?? undefined;
		if (!element) {
			// Empty space: the menu targets the docs root, so nothing may stay selected.
			tree.setFocus([]);
			tree.setSelection([]);
		} else if (!tree.getSelection().includes(element)) {
			tree.setFocus([element]);
			tree.setSelection([element]);
		}
		this._syncContextKeys();
		this.contextMenuService.showContextMenu({
			getAnchor: () => e.anchor,
			menuId: VIBE_DOCS_CONTEXT_MENU,
			contextKeyService: this.scopedContextKeyService,
		});
	}

	private _syncContextKeys(): void {
		const focus = this._focused();
		this._itemType.set(focus ? (focus.isDirectory ? 'folder' : 'file') : 'none');
		this._clipboardHas.set(!!this._clipboard);
	}

	private _toElements(nodes: readonly IVibeDocNode[], parentId: string | undefined): IObjectTreeElement<IVibeDocNode>[] {
		const out: IObjectTreeElement<IVibeDocNode>[] = nodes.map(n => ({
			element: n,
			children: n.isDirectory ? this._toElements(n.children, n.id) : undefined,
			collapsible: n.isDirectory,
			collapsed: n.isDirectory ? this._collapsed.has(n.id) : undefined,
		}));

		const edit = this._edit;
		if (edit && edit.kind !== 'rename' && edit.parentNodeId === parentId) {
			out.push({
				element: {
					id: NEW_NODE_ID,
					name: '',
					relPath: '',
					uri: edit.parent,
					isDirectory: edit.kind === 'newFolder',
					children: [],
				},
				collapsible: false,
			});
		}
		return out;
	}

	private async _paint(): Promise<void> {
		const tree = this._tree;
		if (!tree) {
			return;
		}
		this._nodes = await this._docs.readDocs();
		// An in-flight create must keep the tree mounted — the welcome view would hide its input.
		const nextEmpty = this._nodes.length === 0 && !this._edit;
		if (nextEmpty !== this._rosterEmpty) {
			this._rosterEmpty = nextEmpty;
			this._onDidChangeViewWelcomeState.fire();
		}
		this._syncRosterHostVisibility();
		tree.setChildren(null, this._toElements(this._nodes, undefined));
		tree.layout();

		const reveal = this._revealAfterPaint;
		this._revealAfterPaint = undefined;
		if (reveal) {
			const node = this._findByUri(this._nodes, reveal);
			if (node) {
				try {
					tree.reveal(node);
					tree.setFocus([node]);
					tree.setSelection([node]);
				} catch {
					// The row may be filtered out from under us; focus simply stays put.
				}
			}
		}
		this._syncContextKeys();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._tree?.layout(height, width);
	}

	// --- tree lookups -------------------------------------------------------------------------

	private _focused(): IVibeDocNode | undefined {
		const node = this._tree?.getFocus()[0] ?? undefined;
		return node && node.id !== NEW_NODE_ID ? node : undefined;
	}

	private _selection(): IVibeDocNode[] {
		return (this._tree?.getSelection() ?? []).filter((n): n is IVibeDocNode => !!n && n.id !== NEW_NODE_ID);
	}

	/** Ids are docs-root-relative POSIX paths, so the parent id is just the leading segment. */
	private _parentOf(node: IVibeDocNode): IVibeDocNode | undefined {
		const slash = node.id.lastIndexOf('/');
		return slash < 0 ? undefined : this._findById(this._nodes, node.id.slice(0, slash));
	}

	private _findById(nodes: readonly IVibeDocNode[], id: string): IVibeDocNode | undefined {
		for (const node of nodes) {
			if (node.id === id) {
				return node;
			}
			const hit = this._findById(node.children, id);
			if (hit) {
				return hit;
			}
		}
		return undefined;
	}

	private _findByUri(nodes: readonly IVibeDocNode[], uri: URI): IVibeDocNode | undefined {
		for (const node of nodes) {
			if (isEqual(node.uri, uri)) {
				return node;
			}
			const hit = this._findByUri(node.children, uri);
			if (hit) {
				return hit;
			}
		}
		return undefined;
	}

	/** Where a create or paste lands: inside a focused folder, beside a focused file, else the root. */
	private _destination(): { readonly node: IVibeDocNode | undefined; readonly uri: URI } | undefined {
		const focus = this._focused();
		const node = focus ? (focus.isDirectory ? focus : this._parentOf(focus)) : undefined;
		const uri = node?.uri ?? this._docs.docsRoot();
		return uri ? { node, uri } : undefined;
	}

	private _siblingNames(parent: IVibeDocNode | undefined): string[] {
		return (parent ? parent.children : this._nodes).map(n => n.name);
	}

	// --- inline edit (IEditHost) --------------------------------------------------------------

	getEdit(): IEditContext | undefined {
		return this._edit;
	}

	setDraft(value: string): void {
		if (this._edit) {
			this._edit.draft = value;
		}
	}

	validate(value: string): string | undefined {
		const edit = this._edit;
		if (!edit) {
			return undefined;
		}
		return validateDocName(value, this._finalName(edit, value), edit.siblings, edit.target?.name);
	}

	/** Folders keep the typed name verbatim; files get their markdown extension put back. */
	private _finalName(edit: IEditContext, value: string): string {
		if (edit.kind === 'newFolder' || edit.target?.isDirectory) {
			return value.trim();
		}
		const fallback = edit.kind === 'rename'
			? (VIBE_DOCS_MARKDOWN_RE.exec(edit.target!.name)?.[0] ?? VIBE_DOCS_DEFAULT_EXT)
			: VIBE_DOCS_DEFAULT_EXT;
		return applyMarkdownExtension(value, fallback);
	}

	accept(value: string): void {
		const edit = this._edit;
		if (!edit) {
			return;
		}
		this._edit = undefined; // resolve first, so the widget's blur can't re-enter
		void this._commit(edit, this._finalName(edit, value));
	}

	cancel(): void {
		if (!this._edit) {
			return;
		}
		this._edit = undefined;
		void this._paint();
		this._tree?.domFocus();
	}

	private async _commit(edit: IEditContext, name: string): Promise<void> {
		try {
			if (edit.kind === 'newFolder') {
				this._revealAfterPaint = await this._docs.createFolder(edit.parent, name);
			} else if (edit.kind === 'newFile') {
				const uri = await this._docs.createFile(edit.parent, name);
				this._revealAfterPaint = uri;
				// A doc is created to be written in, and the panel otherwise only ever previews.
				await this._openSource(uri);
			} else if (edit.target) {
				this._revealAfterPaint = await this._docs.rename(edit.target.uri, name);
			}
		} catch (error) {
			this._notificationService.error(localize('vibeDocs.error.commit', "Не удалось сохранить «{0}»: {1}", name, toErrorMessage(error)));
		} finally {
			await this._paint();
			this._tree?.domFocus();
		}
	}

	// --- actions ------------------------------------------------------------------------------

	startCreate(kind: 'file' | 'folder'): void {
		const destination = this._destination();
		if (!destination) {
			return; // no workspace, nowhere to create
		}
		this._edit = {
			kind: kind === 'file' ? 'newFile' : 'newFolder',
			nodeId: NEW_NODE_ID,
			parent: destination.uri,
			parentNodeId: destination.node?.id,
			siblings: this._siblingNames(destination.node),
			draft: '',
		};
		if (destination.node) {
			this._collapsed.delete(destination.node.id); // the new row has to be on screen to be typed into
		}
		void this._paint();
	}

	startRename(): void {
		const target = this._focused();
		if (!target) {
			return;
		}
		const parent = this._parentOf(target);
		this._edit = {
			kind: 'rename',
			nodeId: target.id,
			parent: dirname(target.uri),
			parentNodeId: parent?.id,
			target,
			siblings: this._siblingNames(parent),
			draft: displayName(target),
		};
		void this._paint();
	}

	async deleteSelected(): Promise<void> {
		const targets = this._selection();
		if (!targets.length) {
			return;
		}
		// Losing a file is undoable through the trash; losing a subtree unnoticed is not.
		const hasFilledFolder = targets.some(t => t.isDirectory && t.children.length > 0);
		if (hasFilledFolder) {
			const { confirmed } = await this._dialogService.confirm({
				type: 'warning',
				message: targets.length === 1
					? localize('vibeDocs.delete.one', "Удалить папку «{0}» вместе с содержимым?", displayName(targets[0]))
					: localize('vibeDocs.delete.many', "Удалить выбранные элементы ({0}) вместе с содержимым папок?", targets.length),
				primaryButton: localize('vibeDocs.delete.button', "&&Удалить"),
			});
			if (!confirmed) {
				return;
			}
		}
		try {
			await this._docs.delete(targets.map(t => t.uri));
		} catch (error) {
			this._notificationService.error(localize('vibeDocs.error.delete', "Не удалось удалить: {0}", toErrorMessage(error)));
		}
	}

	cutSelected(): void {
		this._setClipboard(true);
	}

	copySelected(): void {
		this._setClipboard(false);
	}

	private _setClipboard(move: boolean): void {
		const sources = this._selection().map(n => n.uri);
		this._clipboard = sources.length ? { sources, move } : undefined;
		this._clipboardHas.set(!!this._clipboard);
	}

	async pasteIntoTarget(): Promise<void> {
		const clipboard = this._clipboard;
		const destination = this._destination();
		if (!clipboard || !destination) {
			return;
		}
		try {
			await this._docs.paste(destination.uri, clipboard.sources, clipboard.move);
			// A cut is spent once pasted; a copy stays on the buffer for another paste.
			if (clipboard.move) {
				this._clipboard = undefined;
				this._clipboardHas.set(false);
			}
		} catch (error) {
			this._notificationService.error(localize('vibeDocs.error.paste', "Не удалось вставить: {0}", toErrorMessage(error)));
		}
	}

	collapseAll(): void {
		this._tree?.collapseAll();
	}

	async copyPathOfSelected(relative: boolean): Promise<void> {
		const nodes = this._selection();
		if (!nodes.length) {
			return;
		}
		const text = nodes.map(n => relative
			? this._labelService.getUriLabel(n.uri, { relative: true })
			: (n.uri.scheme === Schemas.file ? n.uri.fsPath : n.uri.toString(true))
		).join('\n');
		await this._clipboardService.writeText(text);
	}

	/** Opens the graph tab and points it at this doc — a direct call on the pane `openEditor` hands back. */
	async revealSelectedInGraph(): Promise<void> {
		const target = this._focused();
		if (!target || target.isDirectory) {
			return;
		}
		const id = this._graphService.idOf(target.uri);
		if (!id) {
			return;
		}
		const existing = this._editorService.findEditors(VibeDocsGraphInput.RESOURCE)[0];
		const input = existing?.editor ?? this.instantiationService.createInstance(VibeDocsGraphInput);
		const pane = await this._editorService.openEditor(input, { pinned: true });
		if (pane instanceof VibeDocsGraphPane) {
			pane.reveal(id);
		}
	}

	async revealSelectedInOS(): Promise<void> {
		const target = this._focused();
		if (target) {
			await this._commandService.executeCommand(REVEAL_IN_OS_CMD, target.uri);
		}
	}

	async openSelected(mode: 'preview' | 'source'): Promise<void> {
		const target = this._focused();
		if (!target || target.isDirectory) {
			return;
		}
		await (mode === 'preview' ? this._openPreview(target.uri) : this._openSource(target.uri));
	}

	/** Every file node is markdown (the service filters on `.md`/`.mdx`), so a doc always opens rendered. */
	private async _openPreview(uri: URI): Promise<void> {
		// Report the source before opening: the preview lands as a webview whose `resource` is a
		// synthetic handle, so nothing downstream could work out which doc this is.
		this._graphService.setActiveDoc(uri);
		await this._commandService.executeCommand(MARKDOWN_SHOW_PREVIEW_CMD, uri);
	}

	private async _openSource(uri: URI): Promise<void> {
		this._graphService.setActiveDoc(uri);
		await this._editorService.openEditor({ resource: uri });
	}
}
