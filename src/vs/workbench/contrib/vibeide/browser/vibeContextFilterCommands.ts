/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Extensions, IOutputChannelRegistry, IOutputService } from '../../../services/output/common/output.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';
import { IVibeContextFilterService } from '../common/vibeContextFilterService.js';

export const VIBE_CONTEXT_FILTER_CHANNEL_ID = 'vibeide-context-filter';
export const COMMAND_OPEN_FULL_LOG = 'vibeide.contextFilter.openFullLog';
export const COMMAND_OPEN_SETTINGS = 'vibeide.contextFilter.openSettings';

function ensureChannel(): void {
	const reg = Registry.as<IOutputChannelRegistry>(Extensions.OutputChannels);
	if (!reg.getChannel(VIBE_CONTEXT_FILTER_CHANNEL_ID)) {
		reg.registerChannel({
			id: VIBE_CONTEXT_FILTER_CHANNEL_ID,
			label: localize('vibeide.contextFilter.channel', 'VibeIDE — Context Filter'),
			log: false,
		});
	}
}

CommandsRegistry.registerCommand({
	id: COMMAND_OPEN_FULL_LOG,
	handler: async (accessor: ServicesAccessor) => {
		const filter = accessor.get(IVibeContextFilterService);
		const output = accessor.get(IOutputService);
		const notifications = accessor.get(INotificationService);

		const stats = filter.getLastFilterStats();
		if (!stats || !stats.wasCompacted) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.contextFilter.fullLogUnavailable', 'Полный лог результатов инструментов пока недоступен — компакция ещё не запускалась в этой сессии.'),
			});
			return;
		}

		ensureChannel();
		const ch = output.getChannel(VIBE_CONTEXT_FILTER_CHANNEL_ID);
		if (!ch) {
			return;
		}
		const header = localize(
			'vibeide.contextFilter.fullLogHeader',
			'\n=== Полный результат инструмента «{0}» ({1} → {2} симв.) ===\n',
			stats.toolName,
			stats.originalChars,
			stats.filteredChars,
		);
		ch.append(header);
		ch.append(stats.fullResult);
		ch.append('\n');
		await output.showChannel(VIBE_CONTEXT_FILTER_CHANNEL_ID, /* preserveFocus */ true);
	},
});

CommandsRegistry.registerCommand({
	id: COMMAND_OPEN_SETTINGS,
	handler: async (accessor: ServicesAccessor) => {
		const preferences = accessor.get(IPreferencesService);
		await preferences.openSettings({ query: 'vibeide.context.filter' });
	},
});
