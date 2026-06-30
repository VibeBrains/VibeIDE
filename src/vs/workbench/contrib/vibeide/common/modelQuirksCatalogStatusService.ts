/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';

/**
 * Mirrors `ModelQuirksCatalogStatus` in electron-main/modelQuirks/modelQuirksService.ts.
 * Duplicated here (not imported) because workbench-layer code can't reach into
 * electron-main packages directly — same convention as modelsDevCatalogStatusService.ts.
 *
 *  - `exeAdjacent` — `model-quirks.json` dropped next to VibeIDE.exe (MAX priority).
 *  - `cdn`         — fetched from raw.githubusercontent + cached in userData.
 *  - `bundled`     — shipped TS constant inside the install.
 *  - `empty`       — nothing loaded (provider defaults everywhere).
 */
export interface ModelQuirksCatalogStatus {
	readonly source: 'exeAdjacent' | 'cdn' | 'bundled' | 'empty';
	readonly activeDate: string;
	readonly latestAvailableDate: string;
	readonly staleExeAdjacent: boolean;
	readonly exeAdjacentPath: string | null;
}

interface IModelQuirksCatalogStatusServiceIPC {
	getStatus(): Promise<ModelQuirksCatalogStatus>;
	refresh(): Promise<boolean>;
}

export interface IModelQuirksCatalogStatusService extends IModelQuirksCatalogStatusServiceIPC {
	readonly _serviceBrand: undefined;
}

export const IModelQuirksCatalogStatusService =
	createDecorator<IModelQuirksCatalogStatusService>('modelQuirksCatalogStatusService');

export class ModelQuirksCatalogStatusService implements IModelQuirksCatalogStatusService {
	readonly _serviceBrand: undefined;
	private readonly proxy: IModelQuirksCatalogStatusServiceIPC;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.proxy = ProxyChannel.toService<IModelQuirksCatalogStatusServiceIPC>(
			mainProcessService.getChannel('vibeide-channel-modelQuirksStatus'),
		);
	}

	getStatus(): Promise<ModelQuirksCatalogStatus> {
		return this.proxy.getStatus();
	}

	refresh(): Promise<boolean> {
		return this.proxy.refresh();
	}
}

registerSingleton(IModelQuirksCatalogStatusService, ModelQuirksCatalogStatusService, InstantiationType.Delayed);
