/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';

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

export interface IModelsDevCatalogStatusService {
	readonly _serviceBrand: undefined;
	getStatus(): Promise<ModelsDevCatalogStatus>;
	setDiskCacheTtlHours(hours: number): Promise<void>;
}

export const IModelsDevCatalogStatusService =
	createDecorator<IModelsDevCatalogStatusService>('modelsDevCatalogStatusService');

export class ModelsDevCatalogStatusService implements IModelsDevCatalogStatusService {
	readonly _serviceBrand: undefined;
	private readonly proxy: IModelsDevCatalogStatusService;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.proxy = ProxyChannel.toService<IModelsDevCatalogStatusService>(
			mainProcessService.getChannel('vibeide-channel-modelsDevCatalogStatus'),
		);
	}

	getStatus(): Promise<ModelsDevCatalogStatus> {
		return this.proxy.getStatus();
	}

	setDiskCacheTtlHours(hours: number): Promise<void> {
		return this.proxy.setDiskCacheTtlHours(hours);
	}
}

registerSingleton(IModelsDevCatalogStatusService, ModelsDevCatalogStatusService, InstantiationType.Delayed);
