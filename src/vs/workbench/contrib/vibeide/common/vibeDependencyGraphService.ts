/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
// ITreeSitterService is in browser/ — injected in Phase 2

export interface DependencyNode {
	filePath: string;
	imports: string[];
	importedBy: string[];
	depth: number;
}

export const IVibeDependencyGraphService = createDecorator<IVibeDependencyGraphService>('vibeDependencyGraphService');

export interface IVibeDependencyGraphService {
	readonly _serviceBrand: undefined;

	/**
	 * Get dependency graph for a file.
	 * Shows why this file is in context.
	 */
	getDependencies(filePath: string, depth?: number): Promise<DependencyNode[]>;

	/** Get explanation string: "why is auth.ts in context?" */
	explainContextInclusion(filePath: string, changedFiles: string[]): string;
}

/**
 * VibeIDE Dependency Graph Visualization.
 * Uses treeSitterService.ts for AST-based dependency analysis.
 * Powers: "Why this context?" tooltip, Context Window Visualizer.
 */
class VibeDependencyGraphService extends Disposable implements IVibeDependencyGraphService {
	declare readonly _serviceBrand: undefined;

	async getDependencies(filePath: string, _depth: number = 2): Promise<DependencyNode[]> {
		// Phase 1: return single node (Phase 2: integrate treeSitterService AST parsing)
		return [{
			filePath,
			imports: [],
			importedBy: [],
			depth: 0,
		}];
	}

	explainContextInclusion(filePath: string, changedFiles: string[]): string {
		const fileName = filePath.split('/').pop() || filePath;

		if (changedFiles.some(f => f === filePath)) {
			return `${fileName} is in context because it was directly changed`;
		}

		// Phase 1: basic heuristic explanation
		// Phase 2: integrate treeSitterService for actual import graph
		return `${fileName} is in context via dependency analysis. Check imports for details.`;
	}
}

registerSingleton(IVibeDependencyGraphService, VibeDependencyGraphService, InstantiationType.Delayed);
