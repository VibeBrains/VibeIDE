/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IVibeModelFingerprintService } from './vibeModelFingerprintService.js';
import { IVibeStealthModeService } from './vibeStealthModeService.js';

export const IVibeShareableLinkService = createDecorator<IVibeShareableLinkService>('vibeShareableLinkService');

export interface IVibeShareableLinkService {
	readonly _serviceBrand: undefined;

	/**
	 * Generate anonymized shareable link for debugging.
	 * Returns null if privacy/stealth mode is active (link unavailable).
	 */
	generateLink(requestId: string): string | null;

	/** Check if shareable links are available (disabled in privacy/stealth mode) */
	isAvailable(): boolean;
}

/**
 * VibeIDE Sharable Debug Link.
 * Anonymized snapshot of prompt for issues and support.
 * DISABLED in privacy/stealth mode (UI shows indicator).
 */
class VibeShareableLinkService extends Disposable implements IVibeShareableLinkService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IVibeModelFingerprintService private readonly _fingerprintService: IVibeModelFingerprintService,
		@IVibeStealthModeService private readonly _stealthService: IVibeStealthModeService,
	) {
		super();
	}

	isAvailable(): boolean {
		return !this._stealthService.isEnabled();
	}

	generateLink(requestId: string): string | null {
		if (!this.isAvailable()) {
			vibeLog.info('ShareableLink', 'Unavailable in stealth/privacy mode');
			return null;
		}

		const fingerprint = this._fingerprintService.get(requestId);
		if (!fingerprint) { return null; }

		// Anonymized data — no actual prompt content
		const data = {
			model: fingerprint.modelId,
			provider: fingerprint.providerName,
			promptVersion: fingerprint.promptVersion || '1.0.0',
			feature: fingerprint.feature,
			inputTokens: fingerprint.inputTokens,
		};

		const encoded = Buffer.from(JSON.stringify(data)).toString('base64url');
		return `https://vibeide.io/debug#${encoded}`;
	}
}

registerSingleton(IVibeShareableLinkService, VibeShareableLinkService, InstantiationType.Eager);
