/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { QuotaRow, QuotaTarget } from '../common/subscriptionQuota.js';
import { IVibeSubscriptionQuotaService, VIBE_SUBSCRIPTION_QUOTA_CHANNEL } from '../common/vibeSubscriptionQuotaService.js';

/** Desktop implementation: the request itself runs in the main process (see `vibeSubscriptionQuotaMainService.ts`). */
class VibeSubscriptionQuotaService implements IVibeSubscriptionQuotaService {
	declare readonly _serviceBrand: undefined;

	private readonly _main: { fetchAll(targets: readonly QuotaTarget[]): Promise<QuotaRow[]> };

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this._main = ProxyChannel.toService(mainProcessService.getChannel(VIBE_SUBSCRIPTION_QUOTA_CHANNEL));
	}

	fetchAll(targets: readonly QuotaTarget[]): Promise<QuotaRow[]> {
		return this._main.fetchAll(targets);
	}
}

registerSingleton(IVibeSubscriptionQuotaService, VibeSubscriptionQuotaService, InstantiationType.Delayed);
