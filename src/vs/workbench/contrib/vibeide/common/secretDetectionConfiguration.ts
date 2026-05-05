/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

export class SecretDetectionConfigurationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.secretDetectionConfiguration';

	constructor() {
		super();

		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

		registry.registerConfiguration({
			id: 'vibeide.secretDetection',
			title: localize('secretDetection.title', 'Secret Detection'),
			type: 'object',
			properties: {
				'vibeide.secretDetection.enabled': {
					type: 'boolean',
					default: true,
					description: localize('secretDetection.enabled', 'Enable secret detection and redaction. When enabled, detected secrets will be redacted before sending to LLMs and tools, and masked in chat/markdown rendering.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.secretDetection.mode': {
					type: 'string',
					enum: ['block', 'redact'],
					enumDescriptions: [
						localize('secretDetection.mode.block', 'Block sending messages containing secrets entirely.'),
						localize('secretDetection.mode.redact', 'Allow sending messages but redact secrets with placeholders.'),
					],
					default: 'redact',
					description: localize('secretDetection.mode.description', 'Strictness mode: "block" prevents sending secrets, "redact" allows sending with redacted placeholders.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.secretDetection.disabledPatternIds': {
					type: 'array',
					items: {
						type: 'string',
					},
					default: [],
					description: localize('secretDetection.disabledPatternIds', 'List of pattern IDs to disable. Available patterns: openai-key, anthropic-key, generic-api-key, jwt-token, bearer-token, aws-access-key, aws-secret-key, github-token, gitlab-token, google-api-key, stripe-key, password-pattern, private-key, generic-token.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.secretDetection.customPatterns': {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: {
								type: 'string',
								description: localize('secretDetection.customPattern.id', 'Unique identifier for this pattern.'),
							},
							name: {
								type: 'string',
								description: localize('secretDetection.customPattern.name', 'Human-readable name for this pattern.'),
							},
							pattern: {
								type: 'string',
								description: localize('secretDetection.customPattern.pattern', 'Regex pattern to detect secrets. Use JavaScript regex syntax.'),
							},
							enabled: {
								type: 'boolean',
								default: true,
								description: localize('secretDetection.customPattern.enabled', 'Whether this pattern is enabled.'),
							},
							priority: {
								type: 'number',
								default: 50,
								description: localize('secretDetection.customPattern.priority', 'Priority (higher = checked first). Default patterns use 50-100.'),
							},
						},
						required: ['id', 'name', 'pattern'],
					},
					default: [],
					description: localize('secretDetection.customPatterns', 'Custom secret detection patterns. Add regex patterns to detect additional secret formats.'),
					scope: ConfigurationScope.APPLICATION,
				},
			},
		});
	}
}

// Register the contribution to be initialized early
registerWorkbenchContribution2(SecretDetectionConfigurationContribution.ID, SecretDetectionConfigurationContribution, WorkbenchPhase.BlockRestore);

