/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Mirrors the vibeLog singleton into a VS Code Output channel ("VibeIDE Log") so logs are
// visible without opening DevTools — searchable, persistent, copy-friendly. Wires a sink
// into vibeLog (vibeLog.ts) that appends every passed entry; flushes the existing ring
// buffer on startup so the channel opens with backlog already present.

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IOutputService, IOutputChannelRegistry, Extensions as OutputExtensions } from '../../../services/output/common/output.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { vibeLog, formatVibeLogEntry } from '../common/vibeLog.js';

export const VIBE_LOG_CHANNEL_ID = 'vibeideLog';

class VibeLogOutputChannelContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeLogOutputChannel';

	constructor(
		@IOutputService private readonly outputService: IOutputService,
	) {
		super();
		const registry = Registry.as<IOutputChannelRegistry>(OutputExtensions.OutputChannels);
		registry.registerChannel({
			id: VIBE_LOG_CHANNEL_ID,
			label: localize('vibeide.logging.channelLabel', 'VibeIDE Log'),
			log: false,
		});
		this._register(toDisposable(() => registry.removeChannel(VIBE_LOG_CHANNEL_ID)));

		// Flush the existing ring buffer so the channel starts populated.
		const backlog = vibeLog.getRecent();
		if (backlog.length > 0) {
			this.outputService.getChannel(VIBE_LOG_CHANNEL_ID)?.append(backlog.join('\n') + '\n');
		}

		// Append every subsequent passed entry.
		this._register(toDisposable(vibeLog.addSink(entry => {
			this.outputService.getChannel(VIBE_LOG_CHANNEL_ID)?.append(formatVibeLogEntry(entry) + '\n');
		})));
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
