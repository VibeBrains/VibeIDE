/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { Emitter, Event } from '../../../../base/common/event.js';

// Mirrors electron-main/llmMessage/modelsDevCatalog.ts. Duplicated here (not imported)
// because workbench-layer code can't reach into electron-main packages directly.
/**
 * `source` discriminates how the local snapshot was provisioned:
 *  - `exeDir`   — file dropped next to VibeIDE.exe by the user (preferred);
 *  - `bundled`  — shipped inside the install (`resources/app/resources/vibeide/`);
 *  - `userData` — auto-written cache from a previous successful network fetch
 *                 (Roaming/.config). Lowest priority — confusing to corporate
 *                 users who never put a file there themselves.
 */
export type ModelsDevCatalogStatus =
	| { state: 'unloaded' }
	| { state: 'loaded_from_network' }
	| { state: 'loaded_from_local'; path: string; source: 'exeDir' | 'bundled' | 'userData' }
	| { state: 'failed'; candidatePaths: string[]; catalogUrl: string };

/**
 * IPC-shaped interface — only methods that cross main↔renderer boundary.
 * `Event` properties intentionally excluded; ProxyChannel auto-wires `on*:
 * Event<>` fields, but the event is a RENDERER-LOCAL Emitter here (fires
 * after `recheck()` returns, not pushed from main).
 */
interface IModelsDevCatalogStatusServiceIPC {
	getStatus(): Promise<ModelsDevCatalogStatus>;
	setDiskCacheTtlHours(hours: number): Promise<void>;
	recheck(): Promise<ModelsDevCatalogStatus>;
}

export interface IModelsDevCatalogStatusService extends IModelsDevCatalogStatusServiceIPC {
	readonly _serviceBrand: undefined;
	/**
	 * Fires whenever the in-memory status changes — currently only via
	 * `recheck()`. Renderer-side subscribers (status-bar widget, future
	 * indicators) react to source changes without polling. Note: this
	 * event is NOT pushed from main-process — it fires locally when
	 * `recheck()` returns. For richer change streams (e.g. background
	 * TTL-driven refreshes) main-process would need to push via channel.
	 */
	readonly onDidChangeStatus: Event<ModelsDevCatalogStatus>;
}

export const IModelsDevCatalogStatusService =
	createDecorator<IModelsDevCatalogStatusService>('modelsDevCatalogStatusService');

export class ModelsDevCatalogStatusService implements IModelsDevCatalogStatusService {
	readonly _serviceBrand: undefined;
	private readonly proxy: IModelsDevCatalogStatusServiceIPC;
	private readonly _onDidChangeStatus = new Emitter<ModelsDevCatalogStatus>();
	readonly onDidChangeStatus: Event<ModelsDevCatalogStatus> = this._onDidChangeStatus.event;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.proxy = ProxyChannel.toService<IModelsDevCatalogStatusServiceIPC>(
			mainProcessService.getChannel('vibeide-channel-modelsDevCatalogStatus'),
		);
	}

	getStatus(): Promise<ModelsDevCatalogStatus> {
		return this.proxy.getStatus();
	}

	setDiskCacheTtlHours(hours: number): Promise<void> {
		return this.proxy.setDiskCacheTtlHours(hours);
	}

	async recheck(): Promise<ModelsDevCatalogStatus> {
		const next = await this.proxy.recheck();
		this._onDidChangeStatus.fire(next);
		return next;
	}
}

registerSingleton(IModelsDevCatalogStatusService, ModelsDevCatalogStatusService, InstantiationType.Delayed);
