/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Voice input — raw IPC channel (`vibeide-channel-voice`). Raw `IServerChannel` instead of
 * `ProxyChannel` because session events and download progress are push streams emitted from
 * main while work is running (same reasoning as `ollamaInstallerChannel.ts`).
 */

import { Event } from '../../../../../base/common/event.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { VibeVoiceMainService } from './vibeVoiceMainService.js';
import { VoiceProfileId, VoiceStartSessionOptions } from '../../common/voice/vibeVoiceTypes.js';

export class VibeVoiceChannel implements IServerChannel {

	constructor(private readonly service: VibeVoiceMainService) { }

	listen<T>(_: unknown, event: string): Event<T> {
		if (event === 'onSessionEvent') {
			return this.service.onSessionEvent as Event<T>;
		}
		if (event === 'onDownloadProgress') {
			return this.service.onDownloadProgress as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_: unknown, command: string, arg: unknown): Promise<T> {
		switch (command) {
			case 'getState':
				return this.service.getState() as T;
			case 'ensureModels':
				await this.service.ensureModels(arg as VoiceProfileId);
				return undefined as T;
			case 'startSession':
				this.service.startSession(arg as VoiceStartSessionOptions);
				return undefined as T;
			case 'pushAudio': {
				// Tuple form — see VoiceChannelClient.pushAudio (VSBuffer survives IPC only in arrays).
				const [sessionId, pcm] = arg as [string, VSBuffer];
				this.service.pushAudio(sessionId, pcm.buffer);
				return undefined as T;
			}
			case 'stopSession':
				this.service.stopSession(arg as string);
				return undefined as T;
			case 'cancelSession':
				this.service.cancelSession(arg as string);
				return undefined as T;
		}
		throw new Error(`Unknown command: ${command}`);
	}
}
