/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { getModelQuirksCatalogStatus, refreshModelQuirksCatalogNow, ModelQuirksCatalogStatus } from './modelQuirks/modelQuirksService.js';

/**
 * Thin IPC-friendly wrapper around the model-quirks catalog status. Lives in
 * electron-main; the renderer reaches it via ProxyChannel (see
 * common/modelQuirksCatalogStatusService.ts + channel registration in
 * registerVibeideMainChannels.ts). Mirrors ModelsDevCatalogStatusMainService.
 *
 * Reason it exists separately: ProxyChannel.fromService expects a class with
 * discoverable methods; this keeps the renderer-facing surface intentional.
 */
export class ModelQuirksStatusMainService {
	async getStatus(): Promise<ModelQuirksCatalogStatus> {
		return getModelQuirksCatalogStatus();
	}

	/** Force a CDN refresh now; returns true if the active catalog changed. */
	async refresh(): Promise<boolean> {
		return refreshModelQuirksCatalogNow();
	}
}
