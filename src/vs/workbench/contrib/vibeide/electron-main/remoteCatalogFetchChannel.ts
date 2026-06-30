/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { IHeaders } from '../../../../base/parts/request/common/request.js';
import { IRequestService, asTextOrError, asText } from '../../../../platform/request/common/request.js';

/** Node-backed GET for remote model catalogs — bypasses Chromium CORS in the workbench renderer. */
export class RemoteCatalogFetchChannel implements IServerChannel {

	constructor(private readonly requestService: IRequestService) { }

	listen<T>(_ctx: unknown, _event: string, _arg?: unknown): Event<T> {
		return Event.None;
	}

	async call<T>(_ctx: unknown, command: string, args?: unknown): Promise<T> {
		if (command === 'get') {
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
		if (command === 'probe') {
			// Like 'get' but does NOT throw on non-2xx — returns the HTTP status + body so the caller can
			// distinguish 401/403 (invalid key) from network/server errors when validating a dynamic key.
			const { url, headers } = args as { url: string; headers?: IHeaders };
			const context = await this.requestService.request({
				type: 'GET',
				url,
				headers: {
					Accept: 'application/json',
					...(headers ?? {}),
				},
				timeout: 30_000,
				callSite: 'vibeideRemoteCatalogProbe',
			}, CancellationToken.None);
			const status = context.res.statusCode ?? 0;
			let body: string | null = null;
			try { body = await asText(context); } catch { body = null; }
			const probeResult: { status: number; body: string | null } = { status, body };
			return probeResult as T;
		}
		if (command === 'getGoogleAccessToken') {
			// Uses Application Default Credentials: gcloud auth application-default login,
			// GOOGLE_APPLICATION_CREDENTIALS env, or workload identity.
			const { GoogleAuth } = await import('google-auth-library');
			const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
			const token = await auth.getAccessToken();
			if (!token) {
				throw new Error('GoogleAuth returned an empty access token');
			}
			return token as T;
		}
		throw new Error(`remoteCatalogFetchChannel: unknown command ${command}`);
	}
}
