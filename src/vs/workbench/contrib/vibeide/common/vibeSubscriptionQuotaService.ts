/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { QuotaRow, QuotaTarget } from './subscriptionQuota.js';

/** Main-process channel that asks vendors for subscription remains. */
export const VIBE_SUBSCRIPTION_QUOTA_CHANNEL = 'vibeide-channel-subscriptionQuota';

export const IVibeSubscriptionQuotaService = createDecorator<IVibeSubscriptionQuotaService>('vibeSubscriptionQuotaService');

/**
 * Asks each vendor what its subscription has left — once, when a person opens the spending report.
 *
 * Never polled: every request is one the person made, so a plan that frowns on third-party tools sees no traffic the
 * person did not cause. The request runs in the main process, where an `apiKeyEnv` key is resolvable.
 */
export interface IVibeSubscriptionQuotaService {
	readonly _serviceBrand: undefined;
	/** One row per distinct endpoint and key; targets without a resolvable key are skipped. */
	fetchAll(targets: readonly QuotaTarget[]): Promise<QuotaRow[]>;
}
