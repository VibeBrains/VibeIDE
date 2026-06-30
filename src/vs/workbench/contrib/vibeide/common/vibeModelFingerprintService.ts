/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IAuditLogService } from './auditLogService.js';

export interface ModelFingerprint {
	requestId: string;
	timestamp: number;
	modelId: string;
	providerName: string;
	temperature?: number;
	seed?: number;
	promptVersion?: string;
	inputTokens?: number;
	outputTokens?: number;
	cachedTokens?: number;
	latencyMs?: number;
	feature?: string; // 'chat', 'autocomplete', 'SCM', etc.
}

export const IVibeModelFingerprintService = createDecorator<IVibeModelFingerprintService>('vibeModelFingerprintService');

export interface IVibeModelFingerprintService {
	readonly _serviceBrand: undefined;

	/** Record a request fingerprint */
	record(fingerprint: ModelFingerprint): void;

	/** Get fingerprint for a specific request ID */
	get(requestId: string): ModelFingerprint | undefined;

	/** Get recent fingerprints */
	getRecent(limit?: number): ModelFingerprint[];

	/** Get current session prompt version (from package.json vibeVersion) */
	getPromptVersion(): string;
}

/**
 * VibeIDE Model Fingerprinting: records model, temperature, seed, and version
 * for every LLM request. Powers:
 * - Debug my prompt (shows exact parameters)
 * - Reproducible sessions (replay with same fingerprint)
 * - Model switching audit trail
 */
class VibeModelFingerprintService extends Disposable implements IVibeModelFingerprintService {
	declare readonly _serviceBrand: undefined;

	private readonly _fingerprints = new Map<string, ModelFingerprint>();
	private readonly MAX_STORED = 1000;
	private _promptVersion = '1.0.0';

	constructor(
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
	) {
		super();
	}

	record(fingerprint: ModelFingerprint): void {
		// Evict oldest when at capacity
		if (this._fingerprints.size >= this.MAX_STORED) {
			const firstKey = this._fingerprints.keys().next().value;
			if (firstKey) { this._fingerprints.delete(firstKey); }
		}

		this._fingerprints.set(fingerprint.requestId, fingerprint);
		vibeLog.debug('Fingerprint', `${fingerprint.feature || 'chat'} — ${fingerprint.modelId} @ temp=${fingerprint.temperature ?? 'default'}`);

		// Persist to audit log
		if (this._auditLogService.isEnabled()) {
			this._auditLogService.append({
				ts: fingerprint.timestamp,
				action: 'prompt',
				model: fingerprint.modelId,
				latencyMs: fingerprint.latencyMs,
				ok: true,
				meta: {
					requestId: fingerprint.requestId,
					providerName: fingerprint.providerName,
					temperature: fingerprint.temperature,
					seed: fingerprint.seed,
					promptVersion: fingerprint.promptVersion || this._promptVersion,
					inputTokens: fingerprint.inputTokens,
					outputTokens: fingerprint.outputTokens,
					cachedTokens: fingerprint.cachedTokens,
					feature: fingerprint.feature,
				},
			});
		}
	}

	get(requestId: string): ModelFingerprint | undefined {
		return this._fingerprints.get(requestId);
	}

	getRecent(limit: number = 20): ModelFingerprint[] {
		const all = Array.from(this._fingerprints.values());
		return all.slice(-limit);
	}

	getPromptVersion(): string {
		return this._promptVersion;
	}
}

registerSingleton(IVibeModelFingerprintService, VibeModelFingerprintService, InstantiationType.Eager);
