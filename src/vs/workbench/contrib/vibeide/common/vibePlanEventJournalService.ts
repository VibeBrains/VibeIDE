/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Surface the plan-events journal master flag in VS Code's Settings UI.
// Without this block the key read by `append()` exists only via `?? true`
// fallback, so users never see it in the editor and can't opt out of writing
// plan-step events to disk without editing settings.json by hand.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.planEventsJournal.enable': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.planEventsJournal.enable', 'Писать append-only JSONL журнал plan-step событий (`plan_started`, `plan_step_completed`, `plan_failed`, `plan_resumed`) в `.vibe/plan-events.jsonl`. On-by-default — нужен для resume после reload и для runbook-сценариев; отключение полностью убирает запись на диск.'),
		},
	},
});

export const IVibePlanEventJournalService = createDecorator<IVibePlanEventJournalService>('vibePlanEventJournalService');

/**
 * Local append-only JSONL under `.vibe/plan-events.jsonl` for automation (watchers, scripts).
 * Event names align with roadmap: plan.created, plan.step.completed, plan.step.failed.
 */
export interface IVibePlanEventJournalService {
	readonly _serviceBrand: undefined;
	readonly onEvent: Event<Record<string, unknown>>;
	append(workspaceFolder: URI, record: Record<string, unknown>): Promise<void>;
}

class VibePlanEventJournalService extends Disposable implements IVibePlanEventJournalService {
	declare readonly _serviceBrand: undefined;

	private readonly _onEvent = this._register(new Emitter<Record<string, unknown>>());
	readonly onEvent: Event<Record<string, unknown>> = this._onEvent.event;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	async append(workspaceFolder: URI, record: Record<string, unknown>): Promise<void> {
		// Fire in-process listeners regardless of whether disk-journaling is enabled —
		// subscribers (e.g., the extension API bridge) should see events even when the
		// journal is opted-out.
		this._onEvent.fire(record);

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
			vibeLog.warn('vibePlanEventJournal', '[VibePlanEventJournal] append failed', workspaceFolder.toString(true), e);
		}
	}
}

registerSingleton(IVibePlanEventJournalService, VibePlanEventJournalService, InstantiationType.Delayed);
