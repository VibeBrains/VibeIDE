/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { DocumentSymbol } from '../../../../../editor/common/languages.js';
import { IRepoIndexerService } from '../repoIndexerService.js';
import {
	buildCodeGraph,
	CodeGraph,
	CodeGraphFileInput,
	CodeGraphSymbolInput,
	fileNodeId,
	neighbors,
	NeighborResult,
	parseWhyNotes,
	pathBetween,
	scopedSubgraph,
} from '../../common/codeGraph/vibeCodeGraph.js';

/**
 * Builds the code graph from what the repo index already knows, and enriches it on demand.
 *
 * Two tiers on purpose:
 *  - `getGraph()` is cheap — it reads the index snapshot (paths, symbol names, import
 *    specifiers) and projects it. No file is opened, nothing is parsed.
 *  - `enrich(paths)` is expensive and therefore scoped — for the handful of files a question
 *    actually touches it reads content for "why" notes and asks the language provider for symbol
 *    ranges, which the index does not keep. Running that over a whole repository would mean
 *    spinning up a Monaco model per file; the graph is not worth that.
 */
export const IVibeCodeGraphService = createDecorator<IVibeCodeGraphService>('vibeCodeGraphService');

export interface IVibeCodeGraphService {
	readonly _serviceBrand: undefined;

	/** Whole-repository graph from the index snapshot. Empty while the index is cold. */
	getGraph(): CodeGraph;

	/**
	 * Same graph with the named files enriched: symbol ranges from the language provider and
	 * "why" notes read out of the content, so notes attach to symbols instead of falling back
	 * to the file.
	 */
	getEnrichedGraph(paths: readonly string[]): Promise<CodeGraph>;

	/** Direct neighbours of a node — "what touches this". */
	neighborsOf(nodeId: string): NeighborResult | undefined;

	/** Shortest trace between two nodes, or undefined when nothing connects them. */
	traceBetween(fromNodeId: string, toNodeId: string, maxDepth?: number): string[] | undefined;

	/**
	 * Why a file is where it is: what imports it, what it imports, and the notes explaining it.
	 * This is the question `vibeDependencyGraphService` promised and never answered.
	 */
	explain(path: string): Promise<CodeGraph>;
}

class VibeCodeGraphService extends Disposable implements IVibeCodeGraphService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IRepoIndexerService private readonly _indexer: IRepoIndexerService,
		@IFileService private readonly _files: IFileService,
		@ITextModelService private readonly _models: ITextModelService,
		@ILanguageFeaturesService private readonly _languageFeatures: ILanguageFeaturesService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
	}

	getGraph(): CodeGraph {
		return buildCodeGraph(this._structuralInputs());
	}

	async getEnrichedGraph(paths: readonly string[]): Promise<CodeGraph> {
		const wanted = new Set(paths);
		const snapshot = this._indexer.listStructure();
		const uriOfPath = new Map(snapshot.map(entry => [URI.parse(entry.uri).path, URI.parse(entry.uri)]));
		const inputs = snapshot.map(entry => toInput(entry.uri, entry.symbols, entry.importedFrom));
		const enriched = await Promise.all(inputs.map(async input => {
			const uri = wanted.has(input.path) ? uriOfPath.get(input.path) : undefined;
			return uri ? this._enrichFile(input, uri) : input;
		}));
		return buildCodeGraph(enriched);
	}

	neighborsOf(nodeId: string): NeighborResult | undefined {
		return neighbors(this.getGraph(), nodeId);
	}

	traceBetween(fromNodeId: string, toNodeId: string, maxDepth?: number): string[] | undefined {
		return pathBetween(this.getGraph(), fromNodeId, toNodeId, maxDepth);
	}

	async explain(path: string): Promise<CodeGraph> {
		const graph = await this.getEnrichedGraph([path]);
		// One hop is the honest answer to "why is this file here": its importers, its imports,
		// its symbols and its notes — not a sprawling neighbourhood the reader has to filter.
		return scopedSubgraph(graph, [fileNodeId(path)], 1);
	}

	/** Index snapshot → graph input. Paths are plain fs paths so node ids stay readable. */
	private _structuralInputs(): CodeGraphFileInput[] {
		return this._indexer.listStructure().map(entry => toInput(entry.uri, entry.symbols, entry.importedFrom));
	}

	private async _enrichFile(input: CodeGraphFileInput, uri: URI): Promise<CodeGraphFileInput> {
		const [symbols, notes] = await Promise.all([this._symbolsWithRanges(uri), this._notesOf(uri)]);
		return {
			path: input.path,
			// Ranged symbols supersede the bare names from the index; if the provider gave us
			// nothing, keep the names — a symbol without a range is still a node.
			symbols: symbols ?? input.symbols,
			importSpecifiers: input.importSpecifiers,
			notes,
		};
	}

	private async _symbolsWithRanges(uri: URI): Promise<CodeGraphSymbolInput[] | undefined> {
		let reference;
		try {
			reference = await this._models.createModelReference(uri);
		} catch (error) {
			this._log.trace(`[vibeCodeGraph] no model for ${uri.path}: ${error}`);
			return undefined;
		}
		try {
			const model = reference.object.textEditorModel;
			if (!model) {
				return undefined;
			}
			const providers = this._languageFeatures.documentSymbolProvider.ordered(model);
			const collected: CodeGraphSymbolInput[] = [];
			for (const provider of providers) {
				const symbols = await provider.provideDocumentSymbols(model, CancellationToken.None);
				for (const symbol of symbols ?? []) {
					flattenSymbol(symbol, collected);
				}
				if (collected.length > 0) {
					break; // first provider that answers wins, same rule the indexer uses
				}
			}
			return collected.length > 0 ? collected : undefined;
		} catch (error) {
			this._log.trace(`[vibeCodeGraph] symbol lookup failed for ${uri.path}: ${error}`);
			return undefined;
		} finally {
			reference.dispose();
		}
	}

	private async _notesOf(uri: URI) {
		try {
			const content = await this._files.readFile(uri);
			return parseWhyNotes(content.value.toString());
		} catch (error) {
			this._log.trace(`[vibeCodeGraph] cannot read ${uri.path} for notes: ${error}`);
			return undefined;
		}
	}
}

/** One index entry → graph input. Paths are plain fs paths so node ids stay readable. */
function toInput(uri: string, symbols: readonly string[], importedFrom: readonly string[]): CodeGraphFileInput {
	return {
		path: URI.parse(uri).path,
		symbols: symbols.map(name => ({ name })),
		importSpecifiers: importedFrom,
	};
}

/** Flatten the provider's symbol tree; ranges are 1-based already, which is what the core expects. */
function flattenSymbol(symbol: DocumentSymbol, into: CodeGraphSymbolInput[]): void {
	if (symbol.name) {
		into.push({ name: symbol.name, startLine: symbol.range.startLineNumber, endLine: symbol.range.endLineNumber });
	}
	for (const child of symbol.children ?? []) {
		flattenSymbol(child, into);
	}
}

registerSingleton(IVibeCodeGraphService, VibeCodeGraphService, InstantiationType.Delayed);
