/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export interface MergeConflictResolution {
	filePath: string;
	conflictCount: number;
	resolutions: Array<{
		marker: string;
		chosen: 'ours' | 'theirs' | 'both' | 'custom';
		explanation: string;
	}>;
	confidence: 'high' | 'medium' | 'low';
}

export const IVibeMergeConflictService = createDecorator<IVibeMergeConflictService>('vibeMergeConflictService');

export interface IVibeMergeConflictService {
	readonly _serviceBrand: undefined;

	/**
	 * Analyze merge conflict markers in a file.
	 * Phase 1: structural analysis. Phase 2: LLM-assisted resolution.
	 */
	analyzeConflicts(filePath: string, content: string): MergeConflictResolution;

	/** Check if file has unresolved merge conflicts */
	hasConflicts(content: string): boolean;

	/** Count conflict markers */
	countConflicts(content: string): number;
}

/**
 * VibeIDE AI Merge Conflict Resolution.
 * Analyzes conflict markers and proposes resolution with explanation.
 * Part of Upstream Conflict UI.
 */
class VibeMergeConflictService extends Disposable implements IVibeMergeConflictService {
	declare readonly _serviceBrand: undefined;

	// Git conflict markers
	private readonly CONFLICT_START = '<<<<<<< ';
	private readonly CONFLICT_SEP = '=======';
	private readonly CONFLICT_END = '>>>>>>> ';

	constructor(
	) {
		super();
	}

	hasConflicts(content: string): boolean {
		return content.includes(this.CONFLICT_START);
	}

	countConflicts(content: string): number {
		return (content.match(/<<<<<<< /g) ?? []).length;
	}

	analyzeConflicts(filePath: string, content: string): MergeConflictResolution {
		const count = this.countConflicts(content);
		const resolutions = [];

		if (count === 0) {
			return { filePath, conflictCount: 0, resolutions: [], confidence: 'high' };
		}

		// Parse conflict blocks
		const lines = content.split('\n');
		let inConflict = false;
		let oursBlock: string[] = [];
		let theirsBlock: string[] = [];
		let marker = '';

		for (const line of lines) {
			if (line.startsWith(this.CONFLICT_START)) {
				inConflict = true;
				marker = line;
				oursBlock = [];
				theirsBlock = [];
			} else if (line === this.CONFLICT_SEP && inConflict) {
				// Switch from ours to theirs
			} else if (line.startsWith(this.CONFLICT_END) && inConflict) {
				inConflict = false;
				// Heuristic: prefer shorter/simpler block
				const chosen: 'ours' | 'theirs' = oursBlock.length <= theirsBlock.length ? 'ours' : 'theirs';
				resolutions.push({
					marker,
					chosen,
					explanation: `Phase 2: LLM will explain the semantic difference. Current: prefer ${chosen} (${oursBlock.length} vs ${theirsBlock.length} lines).`,
				});
			}
		}

		vibeLog.debug('MergeConflict', `${count} conflicts in ${filePath}`);

		return {
			filePath,
			conflictCount: count,
			resolutions,
			confidence: 'low', // Phase 1 heuristics only
		};
	}
}

registerSingleton(IVibeMergeConflictService, VibeMergeConflictService, InstantiationType.Eager);
