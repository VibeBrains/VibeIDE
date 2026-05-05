/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

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
		@ILogService _logService: ILogService,
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
		if (!this.isEnabled()) return '';

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
		if (trimmed.match(/^\w+\(/) ) {
			const funcName = trimmed.split('(')[0];
			return `Function call suggested based on ${funcName} usage pattern in codebase.`;
		}

		return `Suggested based on ${context.language} syntax patterns and surrounding context.`;
	}
}

registerSingleton(IVibeAutocompleteExplainService, VibeAutocompleteExplainService, InstantiationType.Delayed);
