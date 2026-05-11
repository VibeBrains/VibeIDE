/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Registers vibeide.cost.* settings that drive `costForecastConfirm.ts`.
// Consumer: ChatThreadService._runChatAgent reads these via IConfigurationService.

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.cost',
	title: localize('vibeide.cost.title', 'VibeIDE — Cost Controls'),
	type: 'object',
	properties: {
		'vibeide.cost.confirmThreshold': {
			type: 'number',
			default: 0.5,
			description: localize('vibeide.cost.confirmThreshold', 'Show a confirmation dialog before sending a request whose estimated cost exceeds this value in USD. Set to 0 to always confirm; set to a very large number to disable. Default: $0.50.'),
		},
		'vibeide.cost.confirmTokenThreshold': {
			type: 'number',
			default: 50000,
			description: localize('vibeide.cost.confirmTokenThreshold', 'Show a confirmation dialog before sending a request whose estimated token count exceeds this value. Default: 50 000.'),
		},
		'vibeide.cost.alwaysConfirm': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.cost.alwaysConfirm', 'Always show a cost confirmation dialog before sending any LLM request, regardless of estimated cost. Useful during development or cost auditing.'),
		},
	},
});
