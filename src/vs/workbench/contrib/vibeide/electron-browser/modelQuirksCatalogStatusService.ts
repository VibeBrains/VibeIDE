/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Desktop implementation of `IModelQuirksCatalogStatusService` (contract lives in
 * `../common/modelQuirksCatalogStatusService.ts`).
 *
 * Sits in `electron-browser/` because it reaches the main process via `IMainProcessService`, which
 * is native-only and banned in `common/**`. The contract stays in `common/` so that its consumers —
 * `vibeModelQuirksSourceStatusBar`, `modelQuirksCatalogStatusContribution` — keep depending on a
 * cross-environment module rather than on a desktop-only one.
 *
 * Loaded from `vs/workbench/workbench.desktop.main.ts`, NOT from `browser/vibeide.contribution.ts`:
 * a browser-layer module cannot import electron-browser.
 */

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IModelQuirksCatalogStatusService, IModelQuirksCatalogStatusServiceIPC, ModelQuirksCatalogStatus } from '../common/modelQuirksCatalogStatusService.js';

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
