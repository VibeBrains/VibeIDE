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
import { joinPath, relativePath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import * as glob from '../../../../base/common/glob.js';
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
	/** Workspace root the spec belongs to — anchor for resolving `scope` globs. */
	readonly rootUri: URI;
	readonly dir: URI;
	readonly product: URI | undefined;
	readonly tech: URI | undefined;
	/** Parsed from PRODUCT.md frontmatter; undefined when absent or unrecognised. */
	readonly status: VibeSpecStatus | undefined;
	/** Workspace-relative globs the spec declares as its file scope (drift boundary). */
	readonly scope: readonly string[] | undefined;
	/** Thread this spec is currently bound to for implementation (spec-drift only fires here). */
	readonly boundThreadId: string | undefined;
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
	/** The spec whose `boundThreadId` matches, or undefined. Used by spec-drift in the agent loop. */
	specForThread(threadId: string): Promise<IVibeSpecEntry | undefined>;
	/** True when `uri` falls inside the spec's declared `scope`. No scope declared → always true (never drifts). */
	isPathInScope(entry: IVibeSpecEntry, uri: URI): boolean;
	/** Write `boundThreadId` into the spec's PRODUCT.md frontmatter (binds a thread to implement it). */
	bindThreadToSpec(entry: IVibeSpecEntry, threadId: string): Promise<void>;
}

const RELOAD_DEBOUNCE_MS = 300;

class VibeSpecsService extends Disposable implements IVibeSpecsService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeSpecs = this._register(new Emitter<void>());
	readonly onDidChangeSpecs = this._onDidChangeSpecs.event;

	private readonly _watchers = this._register(new MutableDisposable<DisposableStore>());
	private readonly _reloadDebouncer = this._register(new RunOnceScheduler(() => this._fireChanged(), RELOAD_DEBOUNCE_MS));

	/** Memoised scan — invalidated whenever specs change (fed to the per-edit drift check hot path). */
	private _cache: readonly IVibeSpecEntry[] | undefined;

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
		this._fireChanged();
	}

	/** Drop the memo and notify — the single place cache invalidation and the change event stay in sync. */
	private _fireChanged(): void {
		this._cache = undefined;
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
		if (this._cache) {
			return this._cache;
		}
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
				const fm = product ? await this._readFrontmatter(product) : {};
				entries.push({
					id: `${folder.name}/${child.name}`,
					specId: child.name,
					rootLabel: folder.name,
					rootUri: folder.uri,
					dir: child.resource,
					product,
					tech,
					status: fm.status,
					scope: fm.scope,
					boundThreadId: fm.boundThreadId,
				});
			}
		}
		entries.sort((a, b) => a.id.localeCompare(b.id));
		this._cache = entries;
		return entries;
	}

	/**
	 * Parse the leading `---`…`---` YAML frontmatter for the fields the panel/drift care about.
	 * Best-effort and dependency-free (no YAML lib): `status`, `scope` (inline `[a, b]` or `- ` list),
	 * `boundThreadId`. Never throws — a malformed block yields empty fields.
	 */
	private async _readFrontmatter(product: URI): Promise<{ status?: VibeSpecStatus; scope?: string[]; boundThreadId?: string }> {
		let text: string;
		try {
			text = (await this._files.readFile(product)).value.toString();
		} catch {
			return {};
		}
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
		if (!fm) {
			return {};
		}
		const block = fm[1];
		const statusLine = /^\s*status\s*:\s*(draft|approved|implemented)\s*$/im.exec(block);
		const boundLine = /^\s*boundThreadId\s*:\s*["']?([^"'\r\n]+?)["']?\s*$/im.exec(block);
		return {
			status: statusLine ? (statusLine[1].toLowerCase() as VibeSpecStatus) : undefined,
			scope: parseScope(block),
			boundThreadId: boundLine ? boundLine[1].trim() : undefined,
		};
	}

	async specForThread(threadId: string): Promise<IVibeSpecEntry | undefined> {
		const specs = await this.readSpecs();
		return specs.find(s => s.boundThreadId === threadId);
	}

	isPathInScope(entry: IVibeSpecEntry, uri: URI): boolean {
		// No declared scope → the spec makes no scope claim, so nothing can drift out of it.
		if (!entry.scope || entry.scope.length === 0) {
			return true;
		}
		const rel = relativePath(entry.rootUri, uri);
		if (rel === undefined) {
			return true; // edit outside the spec's workspace root — not this spec's concern
		}
		return entry.scope.some(g => glob.match(g, rel));
	}

	async bindThreadToSpec(entry: IVibeSpecEntry, threadId: string): Promise<void> {
		if (!entry.product) {
			return;
		}
		let text: string;
		try {
			text = (await this._files.readFile(entry.product)).value.toString();
		} catch {
			return;
		}
		const next = upsertFrontmatterField(text, 'boundThreadId', threadId);
		await this._files.writeFile(entry.product, VSBuffer.fromString(next));
		this._fireChanged();
	}
}

/** Parse a `scope:` frontmatter value: inline `[a, b]` or a following `- item` block list. */
export function parseScope(block: string): string[] | undefined {
	const inline = /^\s*scope\s*:\s*\[([^\]]*)\]\s*$/im.exec(block);
	if (inline) {
		const items = inline[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
		return items.length ? items : undefined;
	}
	// Block form: `scope:` on its own line, then indented `- glob` items until dedent/next key.
	const lines = block.split(/\r?\n/);
	const start = lines.findIndex(l => /^\s*scope\s*:\s*$/i.test(l));
	if (start === -1) {
		return undefined;
	}
	const items: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const m = /^\s*-\s*(.+?)\s*$/.exec(lines[i]);
		if (!m) {
			break;
		}
		items.push(m[1].replace(/^["']|["']$/g, ''));
	}
	return items.length ? items : undefined;
}

/** Insert or replace a scalar `key: value` line inside the leading frontmatter; create a block if none. */
export function upsertFrontmatterField(text: string, key: string, value: string): string {
	const fm = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(text);
	const line = `${key}: ${value}`;
	if (!fm) {
		return `---\n${line}\n---\n${text}`;
	}
	const body = fm[2];
	const keyRe = new RegExp(`^\\s*${key}\\s*:.*$`, 'im');
	const nextBody = keyRe.test(body) ? body.replace(keyRe, line) : `${body}\n${line}`;
	return text.slice(0, fm.index) + fm[1] + nextBody + fm[3] + text.slice(fm.index + fm[0].length);
}

registerSingleton(IVibeSpecsService, VibeSpecsService, InstantiationType.Delayed);
