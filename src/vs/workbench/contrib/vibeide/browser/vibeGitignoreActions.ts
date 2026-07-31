/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * "Add to / remove from .gitignore" for the explorer and editor-tab context menus. Edits the
 * `.gitignore` at the root of the resource's workspace folder with anchored literal entries
 * (see `common/gitignoreEdit.ts`); wildcard patterns are reported, never rewritten.
 */

import { localize, localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { joinPath, relativePath } from '../../../../base/common/resources.js';
import { Action2, registerAction2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IListService } from '../../../../platform/list/browser/listService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ResourceContextKey } from '../../../common/contextkeys.js';
import { EditorResourceAccessor, IEditorCommandsContext, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { getMultiSelectedResources, IExplorerService } from '../../files/browser/files.js';
import { addGitignoreEntry, buildGitignoreEntry, removeGitignoreEntry } from '../common/gitignoreEdit.js';

const whenFileResource = ResourceContextKey.Scheme.isEqualTo(Schemas.file);

/** Explorer multi-selection for a URI arg, tab resource for an editor-context arg, else the active editor. */
function resolveResources(accessor: ServicesAccessor, arg: unknown): URI[] {
	if (URI.isUri(arg)) {
		return getMultiSelectedResources(arg, accessor.get(IListService), accessor.get(IEditorService), accessor.get(IEditorGroupsService), accessor.get(IExplorerService));
	}
	if (arg && typeof arg === 'object' && Object.hasOwn(arg, 'groupId')) {
		const context = arg as IEditorCommandsContext;
		const group = accessor.get(IEditorGroupsService).getGroup(context.groupId);
		const editor = context.editorIndex !== undefined ? group?.getEditorByIndex(context.editorIndex) : group?.activeEditor;
		const resource = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });
		return resource ? [resource] : [];
	}
	const active = accessor.get(IEditorService).activeEditor?.resource;
	return active ? [active] : [];
}

interface IGitignoreTarget {
	readonly gitignoreUri: URI;
	readonly relPath: string;
	readonly isDirectory: boolean;
}

/** Maps resources to their workspace folder's `.gitignore` + relative path; skips roots and outside files. */
async function collectTargets(accessor: ServicesAccessor, resources: URI[]): Promise<{ targets: IGitignoreTarget[]; skipped: number }> {
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const fileService = accessor.get(IFileService);
	const targets: IGitignoreTarget[] = [];
	let skipped = 0;
	for (const resource of resources) {
		const folder = workspaceContextService.getWorkspaceFolder(resource);
		const relPath = folder ? relativePath(folder.uri, resource) : undefined;
		if (!folder || !relPath) { // outside the workspace, or the workspace root itself
			skipped++;
			continue;
		}
		let isDirectory = false;
		try {
			isDirectory = (await fileService.stat(resource)).isDirectory;
		} catch { /* already deleted → treat as file; ignoring it is still legitimate */ }
		targets.push({ gitignoreUri: joinPath(folder.uri, '.gitignore'), relPath, isDirectory });
	}
	return { targets, skipped };
}

async function readGitignore(fileService: IFileService, uri: URI): Promise<string> {
	try {
		return (await fileService.readFile(uri)).value.toString();
	} catch {
		return ''; // no .gitignore yet — created on first write
	}
}

/** Applies `edit` per target, grouped by `.gitignore` file so each file is read/written once. */
async function editGitignores(
	fileService: IFileService,
	targets: IGitignoreTarget[],
	edit: (content: string, target: IGitignoreTarget) => { content: string; changed: boolean },
): Promise<{ changed: string[]; unchanged: string[] }> {
	const byFile = new Map<string, IGitignoreTarget[]>();
	for (const target of targets) {
		const key = target.gitignoreUri.toString();
		byFile.set(key, [...(byFile.get(key) ?? []), target]);
	}
	const changed: string[] = [];
	const unchanged: string[] = [];
	for (const group of byFile.values()) {
		let content = await readGitignore(fileService, group[0].gitignoreUri);
		let dirty = false;
		for (const target of group) {
			const result = edit(content, target);
			content = result.content;
			(result.changed ? changed : unchanged).push(target.relPath);
			dirty = dirty || result.changed;
		}
		if (dirty) {
			await fileService.writeFile(group[0].gitignoreUri, VSBuffer.fromString(content));
		}
	}
	return { changed, unchanged };
}

/** One path is named outright; longer lists collapse to a count. */
function describePaths(paths: string[]): string {
	return paths.length === 1 ? paths[0] : localize('vibeGitignore.pathCount', "{0} путей", paths.length);
}

registerAction2(class AddToGitignoreAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.gitignore.add',
			title: localize2('vibeGitignore.add', "Добавить в .gitignore"),
			f1: true,
			menu: [
				{ id: MenuId.ExplorerContext, group: '7_modification', order: 100, when: whenFileResource },
				{ id: MenuId.EditorTitleContext, group: '2_files', order: 100, when: whenFileResource },
			],
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		const fileService = accessor.get(IFileService);
		const { targets, skipped } = await collectTargets(accessor, resolveResources(accessor, arg));
		if (targets.length === 0) {
			if (skipped > 0) {
				notificationService.info(localize('vibeGitignore.outside', "Файл вне рабочей области — добавить в .gitignore нечего."));
			}
			return;
		}
		const { changed, unchanged } = await editGitignores(fileService, targets, (content, target) => {
			const result = addGitignoreEntry(content, target.relPath, buildGitignoreEntry(target.relPath, target.isDirectory));
			return { content: result.content, changed: result.added };
		});
		if (changed.length > 0 && unchanged.length > 0) {
			notificationService.info(localize('vibeGitignore.addedSome', "Добавлено в .gitignore: {0}; уже были: {1}", describePaths(changed), describePaths(unchanged)));
		} else if (changed.length > 0) {
			notificationService.info(localize('vibeGitignore.added', "Добавлено в .gitignore: {0}", describePaths(changed)));
		} else {
			notificationService.info(localize('vibeGitignore.alreadyThere', "Уже в .gitignore: {0}", describePaths(unchanged)));
		}
	}
});

registerAction2(class RemoveFromGitignoreAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.gitignore.remove',
			title: localize2('vibeGitignore.remove', "Убрать из .gitignore"),
			f1: true,
			menu: [
				{ id: MenuId.ExplorerContext, group: '7_modification', order: 101, when: whenFileResource },
				{ id: MenuId.EditorTitleContext, group: '2_files', order: 101, when: whenFileResource },
			],
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		const fileService = accessor.get(IFileService);
		const { targets, skipped } = await collectTargets(accessor, resolveResources(accessor, arg));
		if (targets.length === 0) {
			if (skipped > 0) {
				notificationService.info(localize('vibeGitignore.outsideRemove', "Файл вне рабочей области — в .gitignore его нет."));
			}
			return;
		}
		const { changed, unchanged } = await editGitignores(fileService, targets, (content, target) => {
			const result = removeGitignoreEntry(content, target.relPath);
			return { content: result.content, changed: result.removed };
		});
		if (changed.length > 0) {
			notificationService.info(localize('vibeGitignore.removed', "Убрано из .gitignore: {0}", describePaths(changed)));
		}
		if (unchanged.length > 0) {
			notificationService.info(localize('vibeGitignore.notFound', "Точной записи в .gitignore не найдено: {0}. Возможно, путь игнорируется шаблоном (например, *.log или dist/**) — такие правила правятся вручную.", describePaths(unchanged)));
		}
	}
});
