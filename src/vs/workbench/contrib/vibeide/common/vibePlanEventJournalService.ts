/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';

export const IVibePlanEventJournalService = createDecorator<IVibePlanEventJournalService>('vibePlanEventJournalService');

/**
 * Local append-only JSONL under `.vibe/plan-events.jsonl` for automation (watchers, scripts).
 * Event names align with roadmap: plan.created, plan.step.completed, plan.step.failed.
 */
export interface IVibePlanEventJournalService {
	readonly _serviceBrand: undefined;
	append(workspaceFolder: URI, record: Record<string, unknown>): Promise<void>;
}

class VibePlanEventJournalService extends Disposable implements IVibePlanEventJournalService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	async append(workspaceFolder: URI, record: Record<string, unknown>): Promise<void> {
		const enabled = this._configurationService.getValue<boolean>('vibeide.planEventsJournal.enable') ?? true;
		if (!enabled) {
			return;
		}
		const line = JSON.stringify({ ts: Date.now(), ...record }) + '\n';
		const vibeDir = joinPath(workspaceFolder, '.vibe');
		const uri = joinPath(workspaceFolder, '.vibe', 'plan-events.jsonl');
		try {
			await this._fileService.createFolder(vibeDir);
			let existing = VSBuffer.alloc(0);
			try {
				existing = (await this._fileService.readFile(uri)).value;
			} catch {
				// new file
			}
			await this._fileService.writeFile(uri, VSBuffer.concat([existing, VSBuffer.fromString(line)]));
		} catch (e) {
			this._logService.warn('[VibePlanEventJournal] append failed', workspaceFolder.toString(true), e);
		}
	}
}

registerSingleton(IVibePlanEventJournalService, VibePlanEventJournalService, InstantiationType.Delayed);
