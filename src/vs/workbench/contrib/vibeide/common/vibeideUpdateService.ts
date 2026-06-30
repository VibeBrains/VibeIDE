/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { VibeideCheckUpdateResponse } from './vibeideUpdateServiceTypes.js';
import { IVibeOutboundRingBuffer } from './vibeOutboundRingBuffer.js';



export interface IVibeideUpdateService {
	readonly _serviceBrand: undefined;
	check: (explicit: boolean) => Promise<VibeideCheckUpdateResponse>;
	/** Download release asset to temp, verify SHA-256, then reveal in system file manager. */
	downloadVerifiedReleaseAsset: (assetUrl: string, expectedSha256Hex: string, fileName: string) => Promise<{ ok: true } | { ok: false; message: string }>;
}


export const IVibeideUpdateService = createDecorator<IVibeideUpdateService>('VibeideUpdateService');


// implemented by calling channel
export class VibeideUpdateService implements IVibeideUpdateService {

	readonly _serviceBrand: undefined;
	private readonly vibeideUpdateService: IVibeideUpdateService;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService, // (only usable on client side)
		@IVibeOutboundRingBuffer private readonly _outboundBuffer: IVibeOutboundRingBuffer,
	) {
		// creates an IPC proxy to use metricsMainService.ts
		this.vibeideUpdateService = ProxyChannel.toService<IVibeideUpdateService>(mainProcessService.getChannel('vibeide-channel-update'));
	}


	// anything transmitted over a channel must be async even if it looks like it doesn't have to be
	check: IVibeideUpdateService['check'] = async (explicit) => {
		const t0 = Date.now();
		const res = await this.vibeideUpdateService.check(explicit);
		// Network panel collector (roadmap §1043) — record update probe in ring buffer.
		this._outboundBuffer.record({
			timestampMs: t0,
			url: 'https://api.github.com/repos/vibeide/update-check',
			method: 'GET',
			statusCode: res !== null ? 200 : 503,
			source: 'update',
			context: explicit ? 'explicit' : 'auto',
		});
		return res;
	};

	downloadVerifiedReleaseAsset: IVibeideUpdateService['downloadVerifiedReleaseAsset'] = async (assetUrl, expectedSha256Hex, fileName) => {
		return await this.vibeideUpdateService.downloadVerifiedReleaseAsset(assetUrl, expectedSha256Hex, fileName);
	};
}

registerSingleton(IVibeideUpdateService, VibeideUpdateService, InstantiationType.Eager);


