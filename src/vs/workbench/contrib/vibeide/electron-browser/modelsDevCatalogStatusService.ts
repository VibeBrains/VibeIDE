/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Desktop implementation of `IModelsDevCatalogStatusService` (contract lives in
 * `../common/modelsDevCatalogStatusService.ts`).
 *
 * Why it sits in `electron-browser/` and not next to the contract: the class talks to the main
 * process through `IMainProcessService`, which is native-only and banned in `common/**` by the
 * layers checker. The contract (status type, decorator, interface) stays in `common/` because
 * consumers — `modelsDevCatalogStatusContribution`, `modelsDevCatalogRecheckAction` — live in
 * `browser/` and must not depend on a desktop-only module.
 *
 * Loaded from `vs/workbench/workbench.desktop.main.ts`, NOT from `browser/vibeide.contribution.ts`:
 * a browser-layer module cannot import electron-browser. Same wiring as
 * `electron-browser/vibeDesktopNotificationService.ts`.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IModelsDevCatalogStatusService, IModelsDevCatalogStatusServiceIPC, ModelsDevCatalogStatus } from '../common/modelsDevCatalogStatusService.js';

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
