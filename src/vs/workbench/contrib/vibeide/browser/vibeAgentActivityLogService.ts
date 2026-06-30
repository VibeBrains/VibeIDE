/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Extensions, IOutputChannelRegistry, IOutputService } from '../../../services/output/common/output.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { formatVibeAgentLogLine } from '../common/vibeAgentLogUtil.js';

export const VIBE_AGENT_ACTIVITY_CHANNEL_ID = 'vibeide-agent-activity';

export const IVibeAgentActivityLogService = createDecorator<IVibeAgentActivityLogService>('vibeAgentActivityLogService');

export interface IVibeAgentActivityLogService {
	readonly _serviceBrand: undefined;
	logStarted(message: string): void;
	logFinished(message: string): void;
	logError(message: string): void;
}

/**
 * Agent tool lifecycle lines in the Output panel (View → Output → VibeIDE Agent Activity).
 */
class VibeAgentActivityLogService extends Disposable implements IVibeAgentActivityLogService {
	declare readonly _serviceBrand: undefined;

	private _channelReady = false;

	constructor(
		@IOutputService private readonly _outputService: IOutputService,
	) {
		super();
		this._ensureChannel();
	}

	private _ensureChannel(): void {
		if (this._channelReady) {
			return;
		}
		const reg = Registry.as<IOutputChannelRegistry>(Extensions.OutputChannels);
		if (!reg.getChannel(VIBE_AGENT_ACTIVITY_CHANNEL_ID)) {
			reg.registerChannel({
				id: VIBE_AGENT_ACTIVITY_CHANNEL_ID,
				label: localize('vibeide.agentActivity.channel', 'Активность агента VibeIDE'),
				log: false,
			});
		}
		this._channelReady = true;
	}

	private _append(line: string): void {
		this._ensureChannel();
		const ch = this._outputService.getChannel(VIBE_AGENT_ACTIVITY_CHANNEL_ID);
		ch?.append(line + '\n');
	}

	logStarted(message: string): void {
		this._append(formatVibeAgentLogLine('Started', message));
	}

	logFinished(message: string): void {
		this._append(formatVibeAgentLogLine('Finished', message));
	}

	logError(message: string): void {
		this._append(formatVibeAgentLogLine('Error', message));
	}
}

registerSingleton(IVibeAgentActivityLogService, VibeAgentActivityLogService, InstantiationType.Delayed);
