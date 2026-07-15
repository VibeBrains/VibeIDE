/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Desktop implementation of `IVibeideUpdateService` (contract lives in
 * `../common/vibeideUpdateService.ts`).
 *
 * Sits in `electron-browser/` because it reaches the main process via `IMainProcessService`, banned
 * in `common/**` and `browser/**`. The contract must stay in `common/`: it is shared by BOTH sides
 * of the channel — `browser/vibeideUpdateActions.ts` injects the decorator, and
 * `electron-main/vibeideUpdateMainService.ts` implements the same interface on the main side.
 *
 * Loaded from `vs/workbench/workbench.desktop.main.ts` — a browser-layer module cannot import
 * electron-browser.
 */

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IVibeideUpdateService } from '../common/vibeideUpdateService.js';
import { IVibeOutboundRingBuffer } from '../common/vibeOutboundRingBuffer.js';

export class VibeideUpdateService implements IVibeideUpdateService {

	readonly _serviceBrand: undefined;
	private readonly vibeideUpdateService: IVibeideUpdateService;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService, // (only usable on client side)
		@IVibeOutboundRingBuffer private readonly _outboundBuffer: IVibeOutboundRingBuffer,
	) {
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
