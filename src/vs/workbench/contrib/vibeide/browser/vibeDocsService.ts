/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Read-only index of markdown docs under a configurable workspace folder (default `docs/`).
 * Backs the «Документы» panel — a markdown-focused view distinct from the full-tree Explorer.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath, relativePath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { VIBE_DOCS_MAX_DEPTH, VIBE_DOCS_ROOT_DEFAULT, VIBE_DOCS_ROOT_SETTING } from './vibeDocsConstants.js';

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
}

const RELOAD_DEBOUNCE_MS = 300;
const MARKDOWN_RE = /\.mdx?$/i;

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

	/** Build the nested tree under `dir`. Returns markdown files and any folders that (transitively) contain them. */
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
				// Prune empty folders — a docs tree shouldn't show dirs with no markdown anywhere inside.
				if (children.length > 0) {
					out.push({ id: rel, name: child.name, relPath: rel, uri: child.resource, isDirectory: true, children: sortNodes(children) });
				}
			} else if (MARKDOWN_RE.test(child.name)) {
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
