/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Index of markdown docs under a configurable workspace folder (default `docs/`), plus the
 * file mutations the «Документы» panel performs on them. A markdown-focused view distinct
 * from the full-tree Explorer.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { basename, dirname, isEqual, isEqualOrParent, joinPath, relativePath } from '../../../../base/common/resources.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';
import { VIBE_DOCS_DEFAULT_EXT, VIBE_DOCS_MARKDOWN_RE, VIBE_DOCS_MAX_DEPTH, VIBE_DOCS_ROOT_DEFAULT, VIBE_DOCS_ROOT_SETTING } from './vibeDocsConstants.js';

export const IVibeDocsService = createDecorator<IVibeDocsService>('vibeDocsService');

export interface IVibeDocNode {
	/** Stable identity: path relative to the docs root (POSIX). */
	readonly id: string;
	/** Basename shown in the tree row. */
	readonly name: string;
	readonly relPath: string;
	readonly uri: URI;
	readonly isDirectory: boolean;
	/** Child nodes (folders first, then files, both alphabetical). Empty for files. */
	readonly children: IVibeDocNode[];
}

export interface IVibeDocsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeDocs: Event<void>;
	/** Top-level nodes (a nested tree) across workspace roots' docs folders. */
	readDocs(): Promise<readonly IVibeDocNode[]>;
	refresh(): void;
	/** Docs folder of the first workspace root — where "create at root" lands. */
	docsRoot(): URI | undefined;
	createFile(parent: URI, name: string): Promise<URI>;
	createFolder(parent: URI, name: string): Promise<URI>;
	rename(target: URI, newName: string): Promise<URI>;
	/** Deletes to the OS trash where the provider supports it, permanently otherwise. */
	delete(targets: readonly URI[]): Promise<void>;
	/** Copies (or moves, when `move`) `sources` into `parent`, renaming around collisions. */
	paste(parent: URI, sources: readonly URI[], move: boolean): Promise<void>;
}

const RELOAD_DEBOUNCE_MS = 300;

/** Characters no mainstream file system accepts — checked up front so the FS error never surfaces. */
const INVALID_NAME_RE = /[\\/:*?"<>|]/;

/**
 * Validates a name typed into the tree's inline input. `typed` is what the user actually entered
 * and `finalName` is it after the markdown extension is restored — the two differ, so emptiness is
 * checked on the former (a blank name mustn't pass as `.md`) and collisions on the latter.
 * `siblings` are the names already in the destination folder; `original` is exempt when renaming.
 */
export function validateDocName(typed: string, finalName: string, siblings: readonly string[], original?: string): string | undefined {
	const trimmed = typed.trim();
	if (!trimmed) {
		return localize('vibeDocs.validate.empty', "Имя не может быть пустым.");
	}
	if (INVALID_NAME_RE.test(trimmed)) {
		return localize('vibeDocs.validate.chars', "Имя не может содержать символы \\ / : * ? \" < > |");
	}
	if (trimmed === '.' || trimmed === '..') {
		return localize('vibeDocs.validate.dots', "«{0}» — недопустимое имя.", trimmed);
	}
	if (original?.toLowerCase() !== finalName.toLowerCase() && siblings.some(s => s.toLowerCase() === finalName.toLowerCase())) {
		return localize('vibeDocs.validate.exists', "«{0}» уже существует в этой папке.", finalName);
	}
	return undefined;
}

/**
 * The panel hides markdown extensions, so the user types a bare name. Honour an extension they
 * typed explicitly; otherwise restore `fallbackExt` — the original one on rename, `.md` on create.
 */
export function applyMarkdownExtension(name: string, fallbackExt: string = VIBE_DOCS_DEFAULT_EXT): string {
	const trimmed = name.trim();
	return VIBE_DOCS_MARKDOWN_RE.test(trimmed) ? trimmed : trimmed + fallbackExt;
}

/** `guide.md` → `guide copy.md` → `guide copy 2.md`. Keeps the extension on the tail. */
function nextFreeName(name: string, taken: ReadonlySet<string>): string {
	if (!taken.has(name.toLowerCase())) {
		return name;
	}
	const ext = VIBE_DOCS_MARKDOWN_RE.exec(name)?.[0] ?? '';
	const base = ext ? name.slice(0, -ext.length) : name;
	for (let i = 1; ; i++) {
		const candidate = i === 1 ? `${base} copy${ext}` : `${base} copy ${i}${ext}`;
		if (!taken.has(candidate.toLowerCase())) {
			return candidate;
		}
	}
}

class VibeDocsService extends Disposable implements IVibeDocsService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeDocs = this._register(new Emitter<void>());
	readonly onDidChangeDocs = this._onDidChangeDocs.event;

	private readonly _watchers = this._register(new MutableDisposable<DisposableStore>());
	private readonly _reloadDebouncer = this._register(new RunOnceScheduler(() => this._onDidChangeDocs.fire(), RELOAD_DEBOUNCE_MS));

	constructor(
		@IFileService private readonly _files: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();

		this._register(this._files.onDidFilesChange(e => {
			if (this._docsRoots().some(root => e.contains(root))) {
				this._reloadDebouncer.schedule();
			}
		}));
		this._register(this._workspace.onDidChangeWorkspaceFolders(() => {
			this._resetWatchers();
			this._reloadDebouncer.schedule();
		}));
		// Changing the configured docs root re-targets the scan and watchers.
		this._register(this._configuration.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VIBE_DOCS_ROOT_SETTING)) {
				this._resetWatchers();
				this._reloadDebouncer.schedule();
			}
		}));
		this._resetWatchers();
	}

	refresh(): void {
		this._onDidChangeDocs.fire();
	}

	private _rootName(): string {
		const v = this._configuration.getValue<string>(VIBE_DOCS_ROOT_SETTING);
		const trimmed = (typeof v === 'string' ? v : '').trim().replace(/^[/\\]+|[/\\]+$/g, '');
		return trimmed || VIBE_DOCS_ROOT_DEFAULT;
	}

	private _docsRoots(): URI[] {
		const name = this._rootName();
		return this._workspace.getWorkspace().folders.map(f => joinPath(f.uri, ...name.split(/[/\\]/)));
	}

	docsRoot(): URI | undefined {
		return this._docsRoots()[0];
	}

	async createFile(parent: URI, name: string): Promise<URI> {
		const uri = joinPath(parent, name);
		await this._files.createFile(uri, undefined, { overwrite: false });
		this.refresh();
		return uri;
	}

	async createFolder(parent: URI, name: string): Promise<URI> {
		const uri = joinPath(parent, name);
		await this._files.createFolder(uri);
		this.refresh();
		return uri;
	}

	async rename(target: URI, newName: string): Promise<URI> {
		const next = joinPath(dirname(target), newName);
		if (isEqual(next, target)) {
			return target;
		}
		await this._files.move(target, next, false);
		this.refresh();
		return next;
	}

	async delete(targets: readonly URI[]): Promise<void> {
		for (const target of targets) {
			await this._files.del(target, {
				recursive: true,
				useTrash: this._files.hasCapability(target, FileSystemProviderCapabilities.Trash),
			});
		}
		this.refresh();
	}

	async paste(parent: URI, sources: readonly URI[], move: boolean): Promise<void> {
		const stat = await this._files.resolve(parent).catch(() => undefined);
		const taken = new Set((stat?.children ?? []).map(c => c.name.toLowerCase()));

		for (const source of sources) {
			// A folder can't be pasted into itself or into its own descendant — that eats the source.
			if (isEqualOrParent(parent, source)) {
				continue;
			}
			// Moving into the folder it already sits in is a no-op, not a copy.
			if (move && isEqual(dirname(source), parent)) {
				continue;
			}
			const name = nextFreeName(basename(source), taken);
			taken.add(name.toLowerCase());
			const target = joinPath(parent, name);
			if (move) {
				await this._files.move(source, target, false);
			} else {
				await this._files.copy(source, target, false);
			}
		}
		this.refresh();
	}

	private _resetWatchers(): void {
		const store = new DisposableStore();
		for (const root of this._docsRoots()) {
			store.add(this._files.watch(root, { recursive: true, excludes: [] }));
		}
		this._watchers.value = store;
	}

	async readDocs(): Promise<readonly IVibeDocNode[]> {
		const roots = this._docsRoots();
		const top: IVibeDocNode[] = [];
		for (const root of roots) {
			const nodes = await this._walk(root, root, 0);
			top.push(...nodes);
		}
		return sortNodes(top);
	}

	/**
	 * Build the nested tree under `dir`: markdown files, and every folder — including empty ones.
	 * Empty folders used to be pruned, but the panel creates folders now, and a folder that
	 * vanishes the moment you make it is worse than a little noise.
	 */
	private async _walk(root: URI, dir: URI, depth: number): Promise<IVibeDocNode[]> {
		if (depth > VIBE_DOCS_MAX_DEPTH) {
			return [];
		}
		let stat;
		try {
			stat = await this._files.resolve(dir);
		} catch {
			return []; // docs root (or subdir) doesn't exist
		}
		const out: IVibeDocNode[] = [];
		for (const child of stat.children ?? []) {
			const rel = relativePath(root, child.resource) ?? child.name;
			if (child.isDirectory) {
				const children = await this._walk(root, child.resource, depth + 1);
				out.push({ id: rel, name: child.name, relPath: rel, uri: child.resource, isDirectory: true, children: sortNodes(children) });
			} else if (VIBE_DOCS_MARKDOWN_RE.test(child.name)) {
				out.push({ id: rel, name: child.name, relPath: rel, uri: child.resource, isDirectory: false, children: [] });
			}
		}
		return out;
	}
}

/** Folders first, then files; each group alphabetical (locale-aware). */
function sortNodes(nodes: IVibeDocNode[]): IVibeDocNode[] {
	return nodes.sort((a, b) => {
		if (a.isDirectory !== b.isDirectory) { return a.isDirectory ? -1 : 1; }
		return a.name.localeCompare(b.name);
	});
}

registerSingleton(IVibeDocsService, VibeDocsService, InstantiationType.Delayed);
