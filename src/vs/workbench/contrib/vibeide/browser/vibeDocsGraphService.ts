/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Builds the docs link graph from disk. The model itself is pure (`common/vibeDocsGraph.ts`);
 * this only supplies it with file contents and caches the result until the docs change.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath, relativePath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { buildDocGraph, IDocFile, IDocGraph } from '../common/vibeDocsGraph.js';
import { IRetrievedDoc, rankDocsForTask } from '../common/docsRetrieval.js';
import { IVibeDocsService } from './vibeDocsService.js';

export const IVibeDocsGraphService = createDecorator<IVibeDocsGraphService>('vibeDocsGraphService');

export interface IVibeDocsGraphService {
	readonly _serviceBrand: undefined;
	/** Fires when the docs changed and a previously read graph is stale. */
	readonly onDidChangeGraph: Event<void>;
	/** Cached between docs changes — the whole corpus is re-read otherwise. */
	readGraph(): Promise<IDocGraph>;
	/** Docs-root-relative id of a resource, or `undefined` if it sits outside the docs root. */
	idOf(resource: URI): string | undefined;
	/** Resource behind a graph node id. */
	uriOf(id: string): URI | undefined;

	/**
	 * Notes worth reading for a task, picked by code — never by a model.
	 *
	 * A retriever built on an LLM means one more paid, slow, fallible call before every turn, just
	 * to decide what to show the LLM. Here it is word overlap over labels and headings plus one hop
	 * along links the author drew by hand.
	 */
	findRelevantNotes(query: string, limit: number): Promise<IRetrievedDoc[]>;

	/**
	 * The doc the user is currently looking at, which is NOT derivable from the active editor:
	 * the docs panel opens markdown in a preview, and a webview's `resource` is a synthetic handle
	 * (the same trap that once printed `webview-markdown.preview-<guid>` as the chat's file chip).
	 * Whoever opens a doc reports it here; the local graph reads it.
	 */
	readonly activeDocId: string | undefined;
	readonly onDidChangeActiveDoc: Event<void>;
	setActiveDoc(resource: URI | undefined): void;
}

/** Only markdown carries links; the graph ignores everything else the docs root holds. */
const MARKDOWN_RE = /\.mdx?$/i;

class VibeDocsGraphService extends Disposable implements IVibeDocsGraphService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeGraph = this._register(new Emitter<void>());
	readonly onDidChangeGraph = this._onDidChangeGraph.event;

	private readonly _onDidChangeActiveDoc = this._register(new Emitter<void>());
	readonly onDidChangeActiveDoc = this._onDidChangeActiveDoc.event;

	private _activeDocId: string | undefined;
	private _cached: Promise<IDocGraph> | undefined;

	constructor(
		@IFileService private readonly _files: IFileService,
		@IVibeDocsService private readonly _docs: IVibeDocsService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		// The docs service already owns the watchers and the configurable root — reuse its signal
		// rather than watching the same tree twice.
		this._register(this._docs.onDidChangeDocs(() => {
			this._cached = undefined;
			this._onDidChangeGraph.fire();
		}));
	}

	readGraph(): Promise<IDocGraph> {
		if (!this._cached) {
			this._cached = this._build();
		}
		return this._cached;
	}

	async findRelevantNotes(query: string, limit: number): Promise<IRetrievedDoc[]> {
		try {
			const graph = await this.readGraph();
			return rankDocsForTask(query, graph.nodes, graph.edges, limit);
		} catch (e) {
			// A corpus that cannot be read is not worth failing a turn over — the agent simply
			// starts without the suggested notes, exactly as it did before this existed.
			this._log.warn(`[VibeDocsGraph] не удалось подобрать заметки: ${e}`);
			return [];
		}
	}

	idOf(resource: URI): string | undefined {
		const root = this._docs.docsRoot();
		if (!root) {
			return undefined;
		}
		const rel = relativePath(root, resource);
		return rel && !rel.startsWith('..') ? rel : undefined;
	}

	uriOf(id: string): URI | undefined {
		const root = this._docs.docsRoot();
		return root ? joinPath(root, ...id.split('/')) : undefined;
	}

	get activeDocId(): string | undefined {
		return this._activeDocId;
	}

	setActiveDoc(resource: URI | undefined): void {
		const id = resource ? this.idOf(resource) : undefined;
		// Editors that aren't docs (a preview webview, a source file elsewhere) leave the last
		// known doc standing rather than blanking the local graph the moment focus moves.
		if (id === undefined || id === this._activeDocId) {
			return;
		}
		this._activeDocId = id;
		this._onDidChangeActiveDoc.fire();
	}

	private async _build(): Promise<IDocGraph> {
		const root = this._docs.docsRoot();
		if (!root) {
			return { nodes: [], edges: [], deadLinks: [] };
		}
		const files: IDocFile[] = [];
		await this._collect(root, root, files);
		await this._collectSkills(files);
		return buildDocGraph(files);
	}

	/**
	 * Project skills, drawn alongside the docs they lean on.
	 *
	 * A skill is instructions the agent follows, and it usually points at the very knowledge the
	 * docs hold — without them on the canvas it is invisible which document a skill depends on,
	 * and which document nothing depends on any more. They enter the graph as `external`, so the
	 * docs gate keeps meaning exactly what it meant before (see `IDocFile.external`).
	 */
	private async _collectSkills(out: IDocFile[]): Promise<void> {
		const folder = this._workspace.getWorkspace().folders[0];
		if (!folder) {
			return;
		}
		const skillsRoot = joinPath(folder.uri, '.vibe', 'skills');
		let stat;
		try {
			stat = await this._files.resolve(skillsRoot);
		} catch {
			return; // no skills in this project
		}
		for (const child of stat.children ?? []) {
			if (!child.isDirectory) {
				continue;
			}
			const skillFile = joinPath(child.resource, 'SKILL.md');
			try {
				const content = await this._files.readFile(skillFile);
				out.push({ id: `.vibe/skills/${child.name}/SKILL.md`, content: content.value.toString(), external: true });
			} catch {
				// A folder without SKILL.md is not a skill; nothing to report.
			}
		}
	}

	private async _collect(root: URI, dir: URI, out: IDocFile[]): Promise<void> {
		let stat;
		try {
			stat = await this._files.resolve(dir);
		} catch {
			return; // the docs root (or a subdir) may not exist
		}
		for (const child of stat.children ?? []) {
			if (child.isDirectory) {
				await this._collect(root, child.resource, out);
				continue;
			}
			if (!MARKDOWN_RE.test(child.name)) {
				continue;
			}
			const id = relativePath(root, child.resource);
			if (!id) {
				continue;
			}
			try {
				const content = await this._files.readFile(child.resource);
				out.push({ id, content: content.value.toString() });
			} catch (error) {
				// One unreadable doc must not cost us the whole graph.
				this._log.warn(`[vibeDocsGraph] cannot read ${child.resource.toString()}`, error);
			}
		}
	}
}

registerSingleton(IVibeDocsGraphService, VibeDocsGraphService, InstantiationType.Delayed);
