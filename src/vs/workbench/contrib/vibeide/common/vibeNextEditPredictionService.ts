/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export interface NextEditPrediction {
	filePath: string;
	lineNumber: number;
	predictedEdit: string;
	confidence: number;
	taskContext?: string;
}

export const IVibeNextEditPredictionService = createDecorator<IVibeNextEditPredictionService>('vibeNextEditPredictionService');

export interface IVibeNextEditPredictionService {
	readonly _serviceBrand: undefined;

	/** Whether next-edit prediction is available for current model */
	isAvailable(): boolean;

	/** Get prediction for current cursor position in agent task context */
	predict(filePath: string, line: number, taskContext?: string): Promise<NextEditPrediction | null>;

	/** Record that user accepted a prediction (for learning) */
	recordAcceptance(prediction: NextEditPrediction): void;

	readonly onPredictionReady: Event<NextEditPrediction>;
}

/**
 * VibeIDE Next-edit Prediction.
 * Tab completion predicts NEXT EDIT in context of current agent task.
 * Different from FIM autocomplete — considers task intent.
 *
 * Requires: capability probe shows extendedThinking or next-edit support.
 * Privacy mode: only local model.
 * Phase 1: framework. Phase 2: actual prediction via model.
 */
class VibeNextEditPredictionService extends Disposable implements IVibeNextEditPredictionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onPredictionReady = this._register(new Emitter<NextEditPrediction>());
	readonly onPredictionReady = this._onPredictionReady.event;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	isAvailable(): boolean {
		// Phase 2: check VibeProviderCapabilityService for nextEditPrediction
		return false; // Disabled by default, enabled when capability probe confirms support
	}

	async predict(filePath: string, line: number, taskContext?: string): Promise<NextEditPrediction | null> {
		if (!this.isAvailable()) return null;
		// Phase 2: call LLM with task context to predict next edit
		this._logService.debug(`[VibeIDE NextEdit] Predicting at ${filePath}:${line}`);
		return null;
	}

	recordAcceptance(prediction: NextEditPrediction): void {
		this._logService.debug(`[VibeIDE NextEdit] Accepted prediction at ${prediction.filePath}:${prediction.lineNumber}`);
	}
}

registerSingleton(IVibeNextEditPredictionService, VibeNextEditPredictionService, InstantiationType.Delayed);
