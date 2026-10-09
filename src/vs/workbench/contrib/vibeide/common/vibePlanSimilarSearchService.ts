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

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { vibeCosineSimilarity, vibeSimpleTextEmbedding } from './vibeSimpleEmbedding.js';
import { IVibeEmbeddingsService } from './embeddings/embeddingSource.js';
import { textsStamp, truncateVector, unitCosine } from './embeddings/vectorFile.js';

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
	 * Similarity over `.vibe/plans/` agent plan markdown files
	 * By meaning through the embeddings source when it is ready, by shared words (local bag of words) otherwise
	 */
	findSimilarPlans(query: string, maxResults?: number): Promise<PlanSimilarityHit[]>;
}

/** A plan read for search: what is shown, and the body that is compared */
type PlanText = Omit<PlanSimilarityHit, 'score'> & { readonly body: string };

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

	/** Plan vectors by model and text stamp: plans rarely change, and a search should not re-embed all of them */
	private readonly _planVectors = new Map<string, Float32Array>();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IVibeEmbeddingsService private readonly _embeddings: IVibeEmbeddingsService,
	) {
		super();
	}

	async findSimilarPlans(query: string, maxResults: number = 8): Promise<PlanSimilarityHit[]> {
		const q = query.trim();
		if (!q) {
			return [];
		}

		const plans = await this._readPlans();
		const scores = await this._scoreByMeaning(q, plans.map(plan => plan.body))
			?? this._scoreByWords(q, plans.map(plan => plan.body));
		const scored = plans.map(({ uri, label, preview }, i) => ({ uri, label, preview, score: scores[i] }));

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, Math.max(1, maxResults));
	}

	private async _readPlans(): Promise<PlanText[]> {
		const plans: PlanText[] = [];
		for (const folder of this._workspaceContextService.getWorkspace().folders) {
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
					const body = extractSearchablePlanText((await this._fileService.readFile(fileUri)).value.toString());
					if (!body.length) {
						continue;
					}
					const preview = body.split(/\r?\n/).find(l => l.trim().length > 0)?.slice(0, 120) ?? child.name;
					const wsFolder = this._workspaceContextService.getWorkspaceFolder(fileUri);
					const label = wsFolder ? `${wsFolder.name}/.vibe/plans/${child.name}` : fileUri.fsPath;
					plans.push({ uri: fileUri, label, preview, body });
				} catch (e) {
					vibeLog.warn('PlanSimilar', `unreadable ${fileUri.toString()}:`, e);
				}
			}
		}
		return plans;
	}

	/** Cosine by meaning, one score per body; undefined when the source is not ready or the call fails */
	private async _scoreByMeaning(query: string, bodies: readonly string[]): Promise<number[] | undefined> {
		const model = this._embeddings.state.modelId;
		if (!this._embeddings.state.ready || bodies.length === 0) {
			return undefined;
		}
		try {
			const keys = bodies.map(body => `${model}:${textsStamp([body])}`);
			const missing = [...new Set(keys.filter(key => !this._planVectors.has(key)))];
			const bodyByKey = new Map(keys.map((key, i) => [key, bodies[i]]));
			const [queryVector, ...planVectors] = await this._embeddings.embed([query, ...missing.map(key => bodyByKey.get(key)!)], CancellationToken.None);
			missing.forEach((key, i) => this._planVectors.set(key, truncateVector(planVectors[i])));
			const q = truncateVector(queryVector);
			return keys.map(key => unitCosine(q, this._planVectors.get(key)!));
		} catch (e) {
			vibeLog.debug('PlanSimilar', 'meaning search failed, falling back to words:', e);
			return undefined;
		}
	}

	private _scoreByWords(query: string, bodies: readonly string[]): number[] {
		const queryEmb = vibeSimpleTextEmbedding(query);
		return bodies.map(body => vibeCosineSimilarity(queryEmb, vibeSimpleTextEmbedding(body)));
	}
}

registerSingleton(IVibePlanSimilarSearchService, VibePlanSimilarSearchService, InstantiationType.Delayed);
