/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import {
	SecretDetectionConfig,
	detectSecrets,
	redactSecretsInObject,
	SecretDetectionResult,
	SecretMatch,
} from './secretDetection.js';

export const ISecretDetectionService = createDecorator<ISecretDetectionService>('secretDetectionService');

export interface ISecretDetectionService {
	readonly _serviceBrand: undefined;
	/** Get current configuration */
	getConfig(): SecretDetectionConfig;
	/** Detect secrets in text */
	detectSecrets(text: string): SecretDetectionResult;
	/** Redact secrets in object (recursively). The redacted copy mirrors the input shape. */
	redactSecretsInObject<T>(obj: T): { redacted: T; hasSecrets: boolean; matches: SecretMatch[] };
	/** Event fired when configuration changes */
	onDidChangeConfig: Event<void>;
}

class SecretDetectionService extends Disposable implements ISecretDetectionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConfig = this._register(new Emitter<void>());
	readonly onDidChangeConfig = this._onDidChangeConfig.event;

	constructor(@IConfigurationService private readonly configurationService: IConfigurationService) {
		super();

		// Listen for configuration changes
		this._register(
			this.configurationService.onDidChangeConfiguration((e) => {
				for (const key of e.affectedKeys) {
					if (key.startsWith('vibeide.secretDetection')) {
						this._onDidChangeConfig.fire();
						break;
					}
				}
			})
		);
	}

	getConfig(): SecretDetectionConfig {
		const config = this.configurationService.getValue<{
			enabled?: boolean;
			customPatterns?: Array<{
				id: string;
				name: string;
				pattern: string;
				enabled: boolean;
				priority: number;
			}>;
			disabledPatternIds?: string[];
			mode?: 'block' | 'redact';
		}>('vibeide.secretDetection');

		return {
			enabled: config?.enabled ?? true,
			customPatterns: config?.customPatterns ?? [],
			disabledPatternIds: config?.disabledPatternIds ?? [],
			mode: config?.mode ?? 'redact',
		};
	}

	detectSecrets(text: string): SecretDetectionResult {
		return detectSecrets(text, this.getConfig());
	}

	redactSecretsInObject<T>(obj: T): { redacted: T; hasSecrets: boolean; matches: SecretMatch[] } {
		return redactSecretsInObject(obj, this.getConfig());
	}
}

registerSingleton(ISecretDetectionService, SecretDetectionService, InstantiationType.Eager);

