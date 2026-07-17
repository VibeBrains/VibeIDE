/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Video analysis (/watch) — raw IPC channel (`vibeide-channel-video`). Raw `IServerChannel`
 * instead of `ProxyChannel` because tools download and pipeline stage progress are push
 * streams emitted from main while work is running (same reasoning as `vibeVoiceChannel.ts`).
 */

import { Event } from '../../../../../base/common/event.js';
import { IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { VibeVideoMainService } from './vibeVideoMainService.js';
import { VideoAnalyzeOptions } from '../../common/video/vibeVideoTypes.js';
import { VoiceProfileId } from '../../common/voice/vibeVoiceTypes.js';

export class VibeVideoChannel implements IServerChannel {

	constructor(private readonly service: VibeVideoMainService) { }

	listen<T>(_: unknown, event: string): Event<T> {
		if (event === 'onToolsDownloadProgress') {
			return this.service.onToolsDownloadProgress as Event<T>;
		}
		if (event === 'onAnalysisProgress') {
			return this.service.onAnalysisProgress as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_: unknown, command: string, arg: unknown): Promise<T> {
		switch (command) {
			case 'getToolsState':
				return this.service.getToolsState() as T;
			case 'ensureTools':
				await this.service.ensureTools();
				return undefined as T;
			case 'updateYtDlp':
				return await this.service.updateYtDlp() as T;
			case 'analyze':
				return await this.service.analyze(arg as VideoAnalyzeOptions) as T;
			case 'transcribe': {
				const { requestId, profileId } = arg as { requestId: string; profileId: VoiceProfileId };
				return await this.service.transcribe(requestId, profileId) as T;
			}
			case 'cancel':
				this.service.cancel(arg as string);
				return undefined as T;
			case 'cleanup':
				await this.service.cleanup(arg as string);
				return undefined as T;
		}
		throw new Error(`Unknown command: ${command}`);
	}
}
