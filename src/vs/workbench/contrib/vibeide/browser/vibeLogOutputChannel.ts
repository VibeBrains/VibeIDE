/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Mirrors the vibeLog singleton into two persistent sinks so logs survive without DevTools:
//   1. an Output channel ("VibeIDE Log") — searchable/copyable within the session;
//   2. a hidden ILoggerService logger writing to `logsHome/vibeide.log` — persists across
//      restarts (support bundles), and replaces the platform-log-file write that the
//      logService→vibeLog migration removed. `hidden: true` keeps it out of the Output
//      dropdown so there is no second "VibeIDE" entry competing with the channel above.

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IOutputService, IOutputChannelRegistry, Extensions as OutputExtensions } from '../../../services/output/common/output.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILoggerService, LogLevel } from '../../../../platform/log/common/log.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { vibeLog, formatVibeLogEntry } from '../common/vibeLog.js';

export const VIBE_LOG_CHANNEL_ID = 'vibeideLog';

class VibeLogOutputChannelContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeLogOutputChannel';

	constructor(
		@IOutputService private readonly outputService: IOutputService,
		@ILoggerService loggerService: ILoggerService,
		@IEnvironmentService environmentService: IEnvironmentService,
	) {
		super();
		const registry = Registry.as<IOutputChannelRegistry>(OutputExtensions.OutputChannels);
		registry.registerChannel({
			id: VIBE_LOG_CHANNEL_ID,
			label: localize('vibeide.logging.channelLabel', 'Лог VibeIDE'),
			log: false,
		});
		this._register(toDisposable(() => registry.removeChannel(VIBE_LOG_CHANNEL_ID)));

		// Flush the existing ring buffer so the channel starts populated.
		const backlog = vibeLog.getRecent();
		if (backlog.length > 0) {
			this.outputService.getChannel(VIBE_LOG_CHANNEL_ID)?.append(backlog.join('\n') + '\n');
		}

		// Append every subsequent passed entry to the Output channel.
		this._register(toDisposable(vibeLog.addSink(entry => {
			this.outputService.getChannel(VIBE_LOG_CHANNEL_ID)?.append(formatVibeLogEntry(entry) + '\n');
		})));

		// Persistent file sink (hidden — no Output-dropdown entry). The logger prepends its
		// own wall-clock + level, so we pass only `[VibeIDE/<category>] <msg>` to avoid doubling.
		const fileLogger = this._register(loggerService.createLogger(
			joinPath(environmentService.logsHome, 'vibeide.log'),
			{ id: 'vibeideFileLog', name: 'VibeIDE', hidden: true, logLevel: LogLevel.Trace },
		));
		const writeEntryToFile = (entry: { level: string; category: string; msg: string }) => {
			const line = `[VibeIDE/${entry.category}] ${entry.msg}`;
			switch (entry.level) {
				case 'error': fileLogger.error(line); break;
				case 'warn': fileLogger.warn(line); break;
				case 'debug': fileLogger.debug(line); break;
				case 'trace': fileLogger.trace(line); break;
				default: fileLogger.info(line); break;
			}
		};
		// Flush the ring buffer to the file too: this sink is wired at AfterRestored,
		// so without this the early-startup lines (already in the buffer, and flushed
		// to the Output channel above) would never reach the persistent file.
		for (const entry of vibeLog.getRecentEntries()) { writeEntryToFile(entry); }
		this._register(toDisposable(vibeLog.addSink(writeEntryToFile)));
	}
}

registerWorkbenchContribution2(VibeLogOutputChannelContribution.ID, VibeLogOutputChannelContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.logging.showChannel',
			f1: true,
			title: localize2('vibeide.logging.showChannel', 'VibeIDE: Показать лог-канал'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IOutputService).showChannel(VIBE_LOG_CHANNEL_ID);
	}
});
