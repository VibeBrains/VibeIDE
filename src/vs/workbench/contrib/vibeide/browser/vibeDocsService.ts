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

export interface IVibeDocEntry {
	/** Stable identity + display label: path relative to the docs root (POSIX). */
	readonly id: string;
	readonly relPath: string;
	readonly uri: URI;
}

export interface IVibeDocsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeDocs: Event<void>;
	readDocs(): Promise<readonly IVibeDocEntry[]>;
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

	async readDocs(): Promise<readonly IVibeDocEntry[]> {
		const entries: IVibeDocEntry[] = [];
		for (const root of this._docsRoots()) {
			await this._walk(root, root, 0, entries);
		}
		entries.sort((a, b) => a.id.localeCompare(b.id));
		return entries;
	}

	private async _walk(root: URI, dir: URI, depth: number, out: IVibeDocEntry[]): Promise<void> {
		if (depth > VIBE_DOCS_MAX_DEPTH) {
			return;
		}
		let stat;
		try {
			stat = await this._files.resolve(dir);
		} catch {
			return; // docs root (or subdir) doesn't exist
		}
		for (const child of stat.children ?? []) {
			if (child.isDirectory) {
				await this._walk(root, child.resource, depth + 1, out);
			} else if (MARKDOWN_RE.test(child.name)) {
				const rel = relativePath(root, child.resource) ?? child.name;
				out.push({ id: rel, relPath: rel, uri: child.resource });
			}
		}
	}
}

registerSingleton(IVibeDocsService, VibeDocsService, InstantiationType.Delayed);
