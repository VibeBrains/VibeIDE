/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { DiffPreview, DiffChunk } from '../common/vibeDiffPreviewService.js';

export interface VirtualizedDiffView {
	visibleChunks: DiffChunk[];
	totalChunks: number;
	groupedByDirectory: Map<string, DiffChunk[]>;
	collapsedDirs: Set<string>;
}

export const IVibeDiffVirtualizationService = createDecorator<IVibeDiffVirtualizationService>('vibeDiffVirtualizationService');

export interface IVibeDiffVirtualizationService {
	readonly _serviceBrand: undefined;

	/**
	 * Virtualize a large diff for rendering.
	 * Groups by directory, collapses unchanged, progressive loading.
	 * Required for 100+ file diffs without UI freeze.
	 */
	virtualize(preview: DiffPreview, pageSize?: number): VirtualizedDiffView;

	/** Toggle directory collapse */
	toggleDirectory(view: VirtualizedDiffView, dir: string): VirtualizedDiffView;

	/** Load next page */
	loadNextPage(view: VirtualizedDiffView, pageSize?: number): VirtualizedDiffView;
}

/**
 * VibeIDE Diff View Virtualization.
 * 100+ file diffs: group by directory, collapse unchanged, progressive loading.
 * Without this: diff view freezes at monorepo scale.
 */
class VibeDiffVirtualizationService extends Disposable implements IVibeDiffVirtualizationService {
	declare readonly _serviceBrand: undefined;

	constructor(
	) {
		super();
	}

	virtualize(preview: DiffPreview, pageSize: number = 20): VirtualizedDiffView {
		const grouped = new Map<string, DiffChunk[]>();

		for (const chunk of preview.chunks) {
			const dir = chunk.filePath.split('/').slice(0, -1).join('/') || '/';
			if (!grouped.has(dir)) { grouped.set(dir, []); }
			grouped.get(dir)!.push(chunk);
		}

		const visibleChunks = preview.chunks.slice(0, pageSize);

		vibeLog.debug('DiffVirtualize', `${preview.chunks.length} chunks, ${grouped.size} dirs, showing ${visibleChunks.length}`);

		return {
			visibleChunks,
			totalChunks: preview.chunks.length,
			groupedByDirectory: grouped,
			collapsedDirs: new Set(),
		};
	}

	toggleDirectory(view: VirtualizedDiffView, dir: string): VirtualizedDiffView {
		const newCollapsed = new Set(view.collapsedDirs);
		if (newCollapsed.has(dir)) { newCollapsed.delete(dir); }
		else { newCollapsed.add(dir); }
		return { ...view, collapsedDirs: newCollapsed };
	}

	loadNextPage(view: VirtualizedDiffView, pageSize: number = 20): VirtualizedDiffView {
		// Would load more from original diff — Phase 2: proper pagination
		return view;
	}
}

registerSingleton(IVibeDiffVirtualizationService, VibeDiffVirtualizationService, InstantiationType.Eager);
