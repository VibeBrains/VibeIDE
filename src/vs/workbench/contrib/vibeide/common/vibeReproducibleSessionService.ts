/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IVibeModelFingerprintService, ModelFingerprint } from './vibeModelFingerprintService.js';

export interface ReproducibleSession {
	originalRequestId: string;
	fingerprint: ModelFingerprint;
	hasStealthMode: boolean;
	warningIfStealth?: string;
}

export const IVibeReproducibleSessionService = createDecorator<IVibeReproducibleSessionService>('vibeReproducibleSessionService');

export interface IVibeReproducibleSessionService {
	readonly _serviceBrand: undefined;

	/** Create a reproducible session spec from a request ID */
	createReproducible(requestId: string, stealthModeWasActive?: boolean): ReproducibleSession | null;

	/** Reproduce a session — returns the parameters to replay */
	reproduce(session: ReproducibleSession): {
		modelId: string;
		temperature?: number;
		seed?: number;
		warning?: string;
	};
}

/**
 * VibeIDE Reproducible Sessions.
 * "Reproduce" button: same prompt, same model, same seed.
 * Warns if Stealth mode was active (cache state differs → result may differ).
 */
class VibeReproducibleSessionService extends Disposable implements IVibeReproducibleSessionService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IVibeModelFingerprintService private readonly _fingerprintService: IVibeModelFingerprintService,
	) {
		super();
	}

	createReproducible(requestId: string, stealthModeWasActive: boolean = false): ReproducibleSession | null {
		const fingerprint = this._fingerprintService.get(requestId);
		if (!fingerprint) {
			vibeLog.warn('Reproducible', `Fingerprint not found for request: ${requestId}`);
			return null;
		}

		return {
			originalRequestId: requestId,
			fingerprint,
			hasStealthMode: stealthModeWasActive,
			warningIfStealth: stealthModeWasActive
				? 'Stealth mode was active — caching was disabled. Reproduction may differ from original due to different cache state.'
				: undefined,
		};
	}

	reproduce(session: ReproducibleSession): {
		modelId: string;
		temperature?: number;
		seed?: number;
		warning?: string;
	} {
		const { fingerprint } = session;
		return {
			modelId: fingerprint.modelId,
			temperature: fingerprint.temperature,
			seed: fingerprint.seed,
			warning: session.warningIfStealth,
		};
	}
}

registerSingleton(IVibeReproducibleSessionService, VibeReproducibleSessionService, InstantiationType.Eager);
