/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { getCatalogStatus, ModelsDevCatalogStatus, recheckCatalog } from './llmMessage/modelsDevCatalog.js';

/**
 * Thin IPC-friendly wrapper around `modelsDevCatalog.getCatalogStatus()`. Lives in
 * electron-main; the renderer reaches it via ProxyChannel (see modelsDevCatalogStatusService.ts
 * in common/ and the channel registration in registerVibeideMainChannels.ts).
 *
 * Sole reason this file exists separately: ProxyChannel.fromService expects a class
 * with discoverable methods, and we want the renderer-side surface to be intentional,
 * not whatever modelsDevCatalog incidentally exports.
 */
export class ModelsDevCatalogStatusMainService {
	async getStatus(): Promise<ModelsDevCatalogStatus> {
		return getCatalogStatus();
	}

	/**
	 * Update the disk-cache TTL used by the models.dev catalog loader. Renderer
	 * calls this whenever `vibeide.catalog.modelsDevCacheTtlHours` setting
	 * changes — env var is per-process and renderer/main are different processes,
	 * so a direct setter is the only way to propagate the value. Idempotent;
	 * value is clamped on the modelsDevCatalog side to the same range as the
	 * setting (1..720 hours).
	 */
	async setDiskCacheTtlHours(hours: number): Promise<void> {
		process.env.VIBEIDE_MODELS_DEV_CACHE_TTL_HOURS = String(hours);
	}

	/**
	 * Force a fresh catalog probe — drops cached in-memory state and re-runs
	 * the priority chain (exeDir → bundled → userData → network). Used by the
	 * «Перепроверить каталог models.dev» Command Palette entry so users can
	 * test a freshly-placed snapshot without restarting the IDE.
	 *
	 * Returns the NEW status snapshot after the probe.
	 */
	async recheck(): Promise<ModelsDevCatalogStatus> {
		recheckCatalog();
		return getCatalogStatus();
	}
}
