/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Read-only index of spec-driven feature docs in the open workspace.
 *
 * Scans each workspace root's `specs/<id>/` folder and reports one entry per `<id>` with which of
 * `PRODUCT.md` / `TECH.md` exist. Backs the «Спеки» panel; the spec files themselves are authored
 * by the agent (skills write-product-spec / write-tech-spec) — this service never writes them.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { VIBE_SPECS_DIR, VIBE_SPECS_PRODUCT_FILE, VIBE_SPECS_TECH_FILE } from './vibeSpecsConstants.js';

export const IVibeSpecsService = createDecorator<IVibeSpecsService>('vibeSpecsService');

/** Lifecycle status read from PRODUCT.md frontmatter (`status:`); implement-specs sets it. */
export type VibeSpecStatus = 'draft' | 'approved' | 'implemented';

export interface IVibeSpecEntry {
	/** Stable identity: `<root-basename>/<specId>` so multi-root workspaces don't collide. */
	readonly id: string;
	/** The `<id>` folder name under `specs/`. */
	readonly specId: string;
	/** Workspace root basename, shown as context when more than one root is open. */
	readonly rootLabel: string;
	readonly dir: URI;
	readonly product: URI | undefined;
	readonly tech: URI | undefined;
	/** Parsed from PRODUCT.md frontmatter; undefined when absent or unrecognised. */
	readonly status: VibeSpecStatus | undefined;
}

export interface IVibeSpecsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSpecs: Event<void>;
	/** Current specs across all workspace roots, sorted by id. Cheap FS resolve, computed on demand. */
	readSpecs(): Promise<readonly IVibeSpecEntry[]>;
	/** URI of `<root>/specs`. */
	specsRootFor(rootUri: URI): URI;
	/** Manually re-emit the change signal (for the view-title «Обновить» action). */
	refresh(): void;
}

const RELOAD_DEBOUNCE_MS = 300;

class VibeSpecsService extends Disposable implements IVibeSpecsService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeSpecs = this._register(new Emitter<void>());
	readonly onDidChangeSpecs = this._onDidChangeSpecs.event;

	private readonly _watchers = this._register(new MutableDisposable<DisposableStore>());
	private readonly _reloadDebouncer = this._register(new RunOnceScheduler(() => this._onDidChangeSpecs.fire(), RELOAD_DEBOUNCE_MS));

	constructor(
		@IFileService private readonly _files: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@ILogService private readonly _log: ILogService,
	) {
		super();

		// Any change under a root's specs/ folder repaints the panel.
		this._register(this._files.onDidFilesChange(e => {
			const roots = this._workspace.getWorkspace().folders.map(f => f.uri);
			if (roots.some(root => e.contains(this.specsRootFor(root)))) {
				this._reloadDebouncer.schedule();
			}
		}));
		// Adding/removing a workspace folder changes the set of specs/ dirs to watch and show.
		this._register(this._workspace.onDidChangeWorkspaceFolders(() => {
			this._resetWatchers();
			this._reloadDebouncer.schedule();
		}));
		this._resetWatchers();
	}

	specsRootFor(rootUri: URI): URI {
		return joinPath(rootUri, VIBE_SPECS_DIR);
	}

	refresh(): void {
		this._onDidChangeSpecs.fire();
	}

	private _resetWatchers(): void {
		const store = new DisposableStore();
		for (const folder of this._workspace.getWorkspace().folders) {
			// Non-existent specs/ dirs can't be watched — they surface on the next reload once created.
			store.add(this._files.watch(this.specsRootFor(folder.uri), { recursive: true, excludes: [] }));
		}
		this._watchers.value = store;
	}

	async readSpecs(): Promise<readonly IVibeSpecEntry[]> {
		const entries: IVibeSpecEntry[] = [];
		for (const folder of this._workspace.getWorkspace().folders) {
			const specsRoot = this.specsRootFor(folder.uri);
			let stat;
			try {
				stat = await this._files.resolve(specsRoot);
			} catch {
				continue; // no specs/ folder in this root
			}
			for (const child of stat.children ?? []) {
				if (!child.isDirectory) {
					continue;
				}
				let docs;
				try {
					docs = await this._files.resolve(child.resource);
				} catch (e) {
					this._log.warn(`[VibeSpecs] Failed to read ${child.resource.toString()}`, e);
					continue;
				}
				const product = docs.children?.find(c => !c.isDirectory && c.name === VIBE_SPECS_PRODUCT_FILE)?.resource;
				const tech = docs.children?.find(c => !c.isDirectory && c.name === VIBE_SPECS_TECH_FILE)?.resource;
				// A spec is only meaningful once at least one of its docs exists.
				if (!product && !tech) {
					continue;
				}
				entries.push({
					id: `${folder.name}/${child.name}`,
					specId: child.name,
					rootLabel: folder.name,
					dir: child.resource,
					product,
					tech,
					status: product ? await this._readStatus(product) : undefined,
				});
			}
		}
		entries.sort((a, b) => a.id.localeCompare(b.id));
		return entries;
	}

	/** Read `status:` from a leading `---`…`---` YAML frontmatter block. Best-effort, never throws. */
	private async _readStatus(product: URI): Promise<VibeSpecStatus | undefined> {
		let text: string;
		try {
			text = (await this._files.readFile(product)).value.toString();
		} catch {
			return undefined;
		}
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
		if (!fm) {
			return undefined;
		}
		const line = /^\s*status\s*:\s*(draft|approved|implemented)\s*$/im.exec(fm[1]);
		return line ? (line[1].toLowerCase() as VibeSpecStatus) : undefined;
	}
}

registerSingleton(IVibeSpecsService, VibeSpecsService, InstantiationType.Delayed);
