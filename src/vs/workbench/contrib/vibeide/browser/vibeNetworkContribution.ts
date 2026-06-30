/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Network outbound connections panel (roadmap §N.5 / line 1043).
 *
 * Registers palette command `vibeide.network.showOutbound`:
 *  - Reads the in-memory ring buffer via `IVibeOutboundRingBuffer.getRedactedSnapshot()`
 *  - Renders via `renderOutboundConnectionsMarkdown`
 *  - Writes to the "VibeIDE Outbound Connections" Output channel and shows it.
 */

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Extensions, IOutputChannelRegistry, IOutputService } from '../../../services/output/common/output.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';
import { IVibeOutboundRingBuffer } from '../common/vibeOutboundRingBuffer.js';
import { renderOutboundConnectionsMarkdown } from '../common/outboundConnectionsAggregator.js';

const VIBE_NETWORK_CHANNEL_ID = 'vibeide-outbound-connections';

function ensureNetworkOutputChannel(): void {
	const reg = Registry.as<IOutputChannelRegistry>(Extensions.OutputChannels);
	if (!reg.getChannel(VIBE_NETWORK_CHANNEL_ID)) {
		reg.registerChannel({
			id: VIBE_NETWORK_CHANNEL_ID,
			label: localize('vibeide.network.channelLabel', 'Исходящие соединения VibeIDE'),
			log: false,
		});
	}
}

CommandsRegistry.registerCommand({
	id: 'vibeide.network.showOutbound',
	handler: async (accessor: ServicesAccessor) => {
		const ringBuffer = accessor.get(IVibeOutboundRingBuffer);
		const outputService = accessor.get(IOutputService);

		ensureNetworkOutputChannel();

		// Last 24h window.
		const snapshot = ringBuffer.getRedactedSnapshot(24 * 60 * 60 * 1000);
		const markdown = renderOutboundConnectionsMarkdown(snapshot);

		const ch = outputService.getChannel(VIBE_NETWORK_CHANNEL_ID);
		if (ch) {
			ch.clear();
			ch.append(markdown);
			await outputService.showChannel(VIBE_NETWORK_CHANNEL_ID);
		}
	},
});
