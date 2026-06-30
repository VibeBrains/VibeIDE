/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Surface the autocomplete explainability flag in VS Code's Settings UI.
// Without this block the key read by `isEnabled()` exists only via `?? false`
// fallback, so users never see it in the editor and can't opt in to «why
// suggested» hover overlays without editing settings.json by hand.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.autocomplete.explainability': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.autocomplete.explainability', 'Включить «почему предложено» hover для autocomplete-подсказок: при наведении на suggestion показывается, какой контекст и какие сигналы повлияли на ранжирование. Off-by-default — добавляет вычислительный overhead на каждое предложение.'),
		},
	},
});

export const IVibeAutocompleteExplainService = createDecorator<IVibeAutocompleteExplainService>('vibeAutocompleteExplainService');

export interface IVibeAutocompleteExplainService {
	readonly _serviceBrand: undefined;

	/** Whether explainability is enabled */
	isEnabled(): boolean;

	/**
	 * Get explanation for an autocomplete suggestion on hover.
	 * Returns 1-2 sentence explanation of WHY this was suggested.
	 */
	explainSuggestion(
		suggestion: string,
		context: { prefix: string; suffix: string; language: string }
	): Promise<string>;
}

/**
 * VibeIDE Autocomplete Explainability.
 * Hover on autocomplete suggestion → brief explanation.
 * "Why is this suggested? Because the function signature suggests..."
 * Opt-in (performance sensitive).
 * No competitor (not in Cursor, not in Copilot) — direct expression of «ты видишь всё».
 */
class VibeAutocompleteExplainService extends Disposable implements IVibeAutocompleteExplainService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	isEnabled(): boolean {
		return this._configurationService.getValue<boolean>('vibeide.autocomplete.explainability') ?? false;
	}

	async explainSuggestion(
		suggestion: string,
		context: { prefix: string; suffix: string; language: string }
	): Promise<string> {
		if (!this.isEnabled()) { return ''; }

		// Phase 1: heuristic explanation based on suggestion type
		// Phase 2: lightweight LLM call (flash/haiku) for semantic explanation
		const trimmed = suggestion.trim();

		if (trimmed.startsWith('return ')) {
			return 'Suggested based on function return type inferred from context.';
		}
		if (trimmed.startsWith('if (') || trimmed.startsWith('if(')) {
			return 'Suggested guard condition based on variable type or null check pattern.';
		}
		if (trimmed.includes('try') && trimmed.includes('catch')) {
			return 'Error handling pattern suggested based on async operation context.';
		}
		if (trimmed.match(/^\w+\(/)) {
			const funcName = trimmed.split('(')[0];
			return `Function call suggested based on ${funcName} usage pattern in codebase.`;
		}

		return `Suggested based on ${context.language} syntax patterns and surrounding context.`;
	}
}

registerSingleton(IVibeAutocompleteExplainService, VibeAutocompleteExplainService, InstantiationType.Delayed);
