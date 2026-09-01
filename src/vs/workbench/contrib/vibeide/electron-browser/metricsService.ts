/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Desktop implementation of `IMetricsService` (contract lives in `../common/metricsService.ts`),
 * plus the `vibeDebugInfo` palette action that reports it.
 *
 * Sits in `electron-browser/` because it proxies `vibe-channel-metrics` through
 * `IMainProcessService`, banned in `common/**` and `browser/**`.
 *
 * Note: `capture()` currently lands in a no-op client on the main side (PostHog was removed from the
 * OSS dependency tree) — the instrumentation is live, the sink is not. `getDebuggingProperties()` is
 * real and backs the `vibeDebugInfo` command.
 *
 * Loaded from `vs/workbench/workbench.desktop.main.ts` — a browser-layer module cannot import
 * electron-browser.
 */

import { vibeLog } from '../common/vibeLog.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { localize2 } from '../../../../nls.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IMetricsService } from '../common/metricsService.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';

// implemented by calling channel
export class MetricsService implements IMetricsService {

	readonly _serviceBrand: undefined;
	private readonly metricsService: IMetricsService;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService // (only usable on client side)
	) {
		// creates an IPC proxy to use metricsMainService.ts
		this.metricsService = ProxyChannel.toService<IMetricsService>(mainProcessService.getChannel('vibe-channel-metrics'));
	}

	// call capture on the channel
	capture(...params: Parameters<IMetricsService['capture']>) {
		this.metricsService.capture(...params);
	}

	setOptOut(...params: Parameters<IMetricsService['setOptOut']>) {
		this.metricsService.setOptOut(...params);
	}


	// anything transmitted over a channel must be async even if it looks like it doesn't have to be
	async getDebuggingProperties(): Promise<object> {
		return this.metricsService.getDebuggingProperties();
	}
}

registerSingleton(IMetricsService, MetricsService, InstantiationType.Eager);


// debugging action
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeDebugInfo',
			f1: true,
			title: localize2('vibeMetricsDebug', 'Записать отладочные сведения в лог'),
			category: VIBE_COMMAND_CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const metricsService = accessor.get(IMetricsService);
		const notifService = accessor.get(INotificationService);

		const debugProperties = await metricsService.getDebuggingProperties();
		vibeLog.info('metrics', 'Metrics:', debugProperties);
		notifService.info(`VibeIDE Debug info:\n${JSON.stringify(debugProperties, null, 2)}`);
	}
});
