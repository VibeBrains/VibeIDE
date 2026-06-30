/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

import { vibeCosineSimilarity, vibeSimpleTextEmbedding } from './vibeSimpleEmbedding.js';

export interface PlanSimilarityHit {
	readonly uri: URI;
	/** Workspace-relative path for display */
	readonly label: string;
	readonly score: number;
	readonly preview: string;
}

export const IVibePlanSimilarSearchService = createDecorator<IVibePlanSimilarSearchService>('vibePlanSimilarSearchService');

export interface IVibePlanSimilarSearchService {
	readonly _serviceBrand: undefined;

	/**
	 * Keyword-style similarity over `.vibe/plans/` agent plan markdown files (local bag-of-words embedding, no cloud).
	 * Complements vector-store RAG for code; reuses the same embedding recipe as `VibeSemanticSearchService`.
	 */
	findSimilarPlans(query: string, maxResults?: number): Promise<PlanSimilarityHit[]>;
}

/** Strip leading YAML frontmatter (first --- ... --- block) for search body. */
function extractSearchablePlanText(raw: string): string {
	const trimmed = raw.replace(/^\uFEFF/, '');
	const m = trimmed.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
	if (m) {
		return trimmed.slice(m[0].length).trim();
	}
	return trimmed.trim();
}

class VibePlanSimilarSearchService extends Disposable implements IVibePlanSimilarSearchService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	async findSimilarPlans(query: string, maxResults: number = 8): Promise<PlanSimilarityHit[]> {
		const q = query.trim();
		if (!q) {
			return [];
		}

		const queryEmb = vibeSimpleTextEmbedding(q);
		const folders = this._workspaceContextService.getWorkspace().folders;
		const scored: PlanSimilarityHit[] = [];

		for (const folder of folders) {
			const plansDir = joinPath(folder.uri, '.vibe', 'plans');
			let children: { name: string; isDirectory?: boolean }[];
			try {
				const stat = await this._fileService.resolve(plansDir);
				if (!stat.children) {
					continue;
				}
				children = stat.children.filter(c => !c.isDirectory && c.name.endsWith('.plan.md'));
			} catch {
				continue;
			}

			for (const child of children) {
				const fileUri = joinPath(plansDir, child.name);
				try {
					const content = (await this._fileService.readFile(fileUri)).value.toString();
					const body = extractSearchablePlanText(content);
					if (!body.length) {
						continue;
					}
					const docEmb = vibeSimpleTextEmbedding(body);
					const score = vibeCosineSimilarity(queryEmb, docEmb);
					const preview = body.split(/\r?\n/).find(l => l.trim().length > 0)?.slice(0, 120) ?? child.name;
					const wsFolder = this._workspaceContextService.getWorkspaceFolder(fileUri);
					const label = wsFolder ? `${wsFolder.name}/.vibe/plans/${child.name}` : fileUri.fsPath;
					scored.push({ uri: fileUri, label, score, preview });
				} catch (e) {
					vibeLog.warn('PlanSimilar', `unreadable ${fileUri.toString()}:`, e);
				}
			}
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, Math.max(1, maxResults));
	}
}

registerSingleton(IVibePlanSimilarSearchService, VibePlanSimilarSearchService, InstantiationType.Delayed);
