/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { IHeaders } from '../../../../base/parts/request/common/request.js';
import { IRequestService, asTextOrError } from '../../../../platform/request/common/request.js';

/** Node-backed GET for remote model catalogs — bypasses Chromium CORS in the workbench renderer. */
export class RemoteCatalogFetchChannel implements IServerChannel {

	constructor(private readonly requestService: IRequestService) { }

	listen<T>(_ctx: unknown, _event: string, _arg?: unknown): Event<T> {
		return Event.None;
	}

	async call<T>(_ctx: unknown, command: string, args?: unknown): Promise<T> {
		if (command !== 'get') {
			throw new Error(`remoteCatalogFetchChannel: unknown command ${command}`);
		}
		const { url, headers } = args as { url: string; headers?: IHeaders };
		const context = await this.requestService.request({
			type: 'GET',
			url,
			headers: {
				Accept: 'application/json',
				...(headers ?? {}),
			},
			timeout: 55_000,
			callSite: 'vibeideRemoteCatalogMain',
		}, CancellationToken.None);
		return (await asTextOrError(context)) as T;
	}
}
