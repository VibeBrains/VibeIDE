/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import {
	COMPONENT_NOTES_PATHS,
	UI_KIT_PATHS,
	parseUiKit,
	DESIGN_SYSTEM_PATHS,
	DesignContext,
	DesignSystemDraft,
	PRODUCT_CONTEXT_PATHS,
	ProductContextDraft,
	parseComponentNotes,
	parseDesignSystem,
	parseProductContext,
	renderDesignSystem,
	renderProductContext,
} from '../../common/designContext/designContextFile.js';

/** What the project says about itself, plus where it said it. */
export interface DesignContextRead {
	context: DesignContext;
	/** Workspace-relative paths actually read; a missing entry means the file is absent. */
	sources: { product?: string; design?: string; components?: string; uiKit?: string };
	/** False when no folder is open — different from "no context written yet". */
	hasWorkspace: boolean;
}

export const IVibeDesignContextService = createDecorator<IVibeDesignContextService>('vibeDesignContextService');

export interface IVibeDesignContextService {
	readonly _serviceBrand: undefined;
	/** Reads the context files. Absent files are silence, not an error. */
	read(): Promise<DesignContextRead>;
	/** Writes `product.md`, returning where it landed. */
	writeProduct(draft: ProductContextDraft): Promise<string | undefined>;
	/** Writes `design.md`, returning where it landed. */
	writeDesign(draft: DesignSystemDraft): Promise<string | undefined>;
}

/**
 * Reads and writes the project's design context (`product.md` + `design.md` + `components.md`).
 *
 * No cache and no watcher on purpose: the files are two small markdown documents read on an agent
 * command, not on a hot path, and a cache here would add an invalidation problem in exchange for
 * microseconds nobody measures. Whoever asks gets what is on disk right now.
 *
 * Depends on platform services only — it must never grow a dependency on a Vibe service, because
 * `ToolsService` injects it and that is how the `vibeModalRoot` dependency cycle happened before.
 */
class VibeDesignContextService extends Disposable implements IVibeDesignContextService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	async read(): Promise<DesignContextRead> {
		const root = this._root();
		if (!root) {
			return { context: {}, sources: {}, hasWorkspace: false };
		}
		const product = await this._readFirst(root, PRODUCT_CONTEXT_PATHS);
		const design = await this._readFirst(root, DESIGN_SYSTEM_PATHS);
		const components = await this._readFirst(root, COMPONENT_NOTES_PATHS);
		const uiKit = await this._readFirst(root, UI_KIT_PATHS);
		return {
			context: {
				product: parseProductContext(product?.content),
				design: parseDesignSystem(design?.content),
				components: parseComponentNotes(components?.content),
				uiKit: parseUiKit(uiKit?.content),
			},
			sources: { product: product?.path, design: design?.path, components: components?.path, uiKit: uiKit?.path },
			hasWorkspace: true,
		};
	}

	async writeProduct(draft: ProductContextDraft): Promise<string | undefined> {
		return this._write(PRODUCT_CONTEXT_PATHS, renderProductContext(draft));
	}

	async writeDesign(draft: DesignSystemDraft): Promise<string | undefined> {
		return this._write(DESIGN_SYSTEM_PATHS, renderDesignSystem(draft));
	}

	private async _write(candidates: readonly string[], content: string): Promise<string | undefined> {
		const root = this._root();
		if (!root) {
			return undefined;
		}
		// An existing file wins over our preferred location: a project that already keeps its
		// context in the root must not end up with two files disagreeing with each other.
		const existing = await this._readFirst(root, candidates);
		const target = existing?.path ?? candidates[0];
		await this._fileService.writeFile(joinPath(root, ...target.split('/')), VSBuffer.fromString(content));
		return target;
	}

	private async _readFirst(
		root: URI,
		candidates: readonly string[],
	): Promise<{ path: string; content: string } | undefined> {
		for (const candidate of candidates) {
			try {
				const file = await this._fileService.readFile(joinPath(root, ...candidate.split('/')));
				const content = file.value.toString();
				if (content.trim()) {
					return { path: candidate, content };
				}
			} catch {
				// Absent or unreadable — try the next location.
			}
		}
		return undefined;
	}

	private _root(): URI | undefined {
		const folders = this._workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}
}

registerSingleton(IVibeDesignContextService, VibeDesignContextService, InstantiationType.Delayed);
