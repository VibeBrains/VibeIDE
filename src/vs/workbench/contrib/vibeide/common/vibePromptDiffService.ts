/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export interface PromptDiffResult {
	oldVersion: string;
	newVersion: string;
	additions: string[];
	removals: string[];
	hasChanges: boolean;
	summary: string;
}

export const IVibePromptDiffService = createDecorator<IVibePromptDiffService>('vibePromptDiffService');

export interface IVibePromptDiffService {
	readonly _serviceBrand: undefined;

	/**
	 * Called on IDE startup — compare current system prompt vs stored.
	 * If changed: fire onPromptChanged event (shows diff notification).
	 */
	checkForChanges(ideVersion: string, currentSystemPrompt: string): PromptDiffResult | null;

	readonly onPromptChanged: Event<PromptDiffResult>;
}

const STORAGE_KEY_PROMPT = 'vibeide.lastSystemPrompt';
const STORAGE_KEY_VERSION = 'vibeide.lastPromptVersion';

/**
 * VibeIDE Prompt Diff on IDE Update.
 * Shows unified diff of system prompt changes when IDE updates.
 * Compliance: you can see exactly how agent behavior changed.
 */
class VibePromptDiffService extends Disposable implements IVibePromptDiffService {
	declare readonly _serviceBrand: undefined;

	private readonly _onPromptChanged = this._register(new Emitter<PromptDiffResult>());
	readonly onPromptChanged = this._onPromptChanged.event;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
	}

	checkForChanges(ideVersion: string, currentSystemPrompt: string): PromptDiffResult | null {
		const storedPrompt = this._storageService.get(STORAGE_KEY_PROMPT, StorageScope.APPLICATION) ?? '';
		const storedVersion = this._storageService.get(STORAGE_KEY_VERSION, StorageScope.APPLICATION) ?? '';

		// Store current for next comparison
		this._storageService.store(STORAGE_KEY_PROMPT, currentSystemPrompt, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._storageService.store(STORAGE_KEY_VERSION, ideVersion, StorageScope.APPLICATION, StorageTarget.MACHINE);

		if (!storedPrompt || storedPrompt === currentSystemPrompt) {
			return null; // No change
		}

		const oldLines = storedPrompt.split('\n');
		const newLines = currentSystemPrompt.split('\n');
		const additions = newLines.filter(l => !oldLines.includes(l) && l.trim());
		const removals = oldLines.filter(l => !newLines.includes(l) && l.trim());

		const result: PromptDiffResult = {
			oldVersion: storedVersion,
			newVersion: ideVersion,
			additions,
			removals,
			hasChanges: true,
			summary: `System prompt updated: +${additions.length} lines, -${removals.length} lines`,
		};

		vibeLog.info('PromptDiff', `${result.summary}`);
		this._onPromptChanged.fire(result);
		return result;
	}
}

registerSingleton(IVibePromptDiffService, VibePromptDiffService, InstantiationType.Eager);
