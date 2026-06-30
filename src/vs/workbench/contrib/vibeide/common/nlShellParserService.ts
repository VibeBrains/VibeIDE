/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILLMMessageService } from './sendLLMMessageService.js';
import { IVibeideSettingsService } from './vibeideSettingsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { autoModelFallbackProviderOrder, isValidProviderModelSelection, ModelSelection } from './vibeideSettingsTypes.js';
import { analyzeNLShellSafety } from './nlShellSafetyAnalyzer.js';

export const INLShellParserService = createDecorator<INLShellParserService>('nlShellParserService');

export interface ParsedShellCommand {
	command: string;
	explanation: string;
	estimatedRisk: 'low' | 'medium' | 'high';
	requiresConfirmation: boolean;
}

export interface INLShellParserService {
	readonly _serviceBrand: undefined;

	/**
	 * Parse natural language into a shell command
	 * @param nlInput Natural language description of the command
	 * @param cwd Current working directory context
	 * @param token Cancellation token
	 * @returns Parsed command with explanation and risk assessment
	 */
	parseNLToShell(nlInput: string, cwd: string | null, token: CancellationToken): Promise<ParsedShellCommand>;
}

const NL_TO_SHELL_PROMPT = `You are a shell command parser. Convert natural language requests into safe, executable shell commands.

Rules:
1. Output ONLY a valid shell command (bash/zsh on macOS/Linux, cmd/powershell on Windows)
2. Use standard commands: ls, cd, git, npm, etc.
3. Never include destructive operations without explicit user request
4. Prefer safe alternatives (e.g., git status instead of git reset --hard)
5. If the request is ambiguous, choose the safest interpretation
6. Do not include explanations or markdown - just the command

Examples:
- "list files" → "ls -la"
- "show git branches" → "git branch -a"
- "run tests" → "npm test"
- "check git status" → "git status"
- "install dependencies" → "npm install"

User request: {nlInput}

Output the shell command only (no markdown, no code blocks, just the command):`;

class NLShellParserService implements INLShellParserService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IVibeideSettingsService private readonly settingsService: IVibeideSettingsService,
	) {
	}

	async parseNLToShell(nlInput: string, cwd: string | null, token: CancellationToken): Promise<ParsedShellCommand> {
		// Get model selection from settings (use Chat feature)
		const settings = this.settingsService.state;
		let modelSelection = settings.modelSelectionOfFeature['Chat'] || { providerName: 'auto', modelName: 'auto' };

		// If auto is selected, try to find a fallback model
		if (modelSelection.providerName === 'auto' && modelSelection.modelName === 'auto') {
			// Try to find the first available configured model (prefer online models first, then local)
			let fallbackModel: ModelSelection | null = null;

			for (const providerName of autoModelFallbackProviderOrder) {
				const providerSettings = settings.settingsOfProvider[providerName];
				if (providerSettings && providerSettings._didFillInProviderSettings) {
					const models = providerSettings.models || [];
					const firstModel = models.find(m => !m.isHidden);
					if (firstModel) {
						fallbackModel = { providerName, modelName: firstModel.modelName };
						break;
					}
				}
			}

			if (fallbackModel) {
				modelSelection = fallbackModel;
			} else {
				throw new Error('No model provider configured. Please configure a model provider in VibeIDE Settings.');
			}
		}

		// Type guard: ensure modelSelection is valid (not "auto")
		if (!isValidProviderModelSelection(modelSelection)) {
			throw new Error('Invalid model selection. Please select a valid model in settings.');
		}

		const modelOptions = settings.optionsOfModelSelection['Chat']?.[modelSelection.providerName]?.[modelSelection.modelName];
		const overrides = settings.overridesOfModel;

		const prompt = NL_TO_SHELL_PROMPT.replace('{nlInput}', nlInput);

		let response = '';
		let isComplete = false;

		const requestId = this.llmMessageService.sendLLMMessage({
			messagesType: 'chatMessages',
			chatMode: 'normal',
			messages: [
				{ role: 'user', content: prompt },
			],
			separateSystemMessage: undefined,
			modelSelection,
			modelSelectionOptions: modelOptions,
			overridesOfModel: overrides,
			logging: { loggingName: 'NL Shell Parser', loggingExtras: { nlInput } },
			onText: ({ fullText }) => {
				response = fullText;
				if (token.isCancellationRequested) {
					this.llmMessageService.abort(requestId || '');
				}
			},
			onFinalMessage: ({ fullText }) => {
				response = fullText;
				isComplete = true;
			},
			onError: (error) => {
				throw new Error(`Failed to parse NL to shell: ${error.message || String(error)}`);
			},
			onAbort: () => {
				isComplete = true;
			},
		});

		// Wait for completion or cancellation
		while (!isComplete && !token.isCancellationRequested) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}

		if (token.isCancellationRequested) {
			this.llmMessageService.abort(requestId || '');
			throw new Error('NL parsing cancelled');
		}

		// Clean up response - remove markdown code blocks, trim whitespace
		let command = response.trim();
		command = command.replace(/^```[\w]*\n?/g, '').replace(/```$/g, '').trim();
		command = command.split('\n')[0].trim(); // Take first line only

		if (!command) {
			throw new Error('Failed to parse natural language to shell command');
		}

		// Assess risk using simple heuristics (will be enhanced by danger detection)
		const estimatedRisk = this._assessRisk(command);
		const requiresConfirmation = estimatedRisk !== 'low';

		return {
			command,
			explanation: `Parsed "${nlInput}" to: ${command}`,
			estimatedRisk,
			requiresConfirmation,
		};
	}

	private _assessRisk(command: string): 'low' | 'medium' | 'high' {
		// Adopt pure helper `analyzeNLShellSafety` (roadmap §990 / §1052) — single
		// source of truth for destructive-command detection, also consumed by the
		// chat-mode confirm dialog and `vibe doctor --shell-safety` audit.
		const tokens = command.trim().split(/\s+/);
		const head = tokens[0] ?? '';
		const args = tokens.slice(1);
		const result = analyzeNLShellSafety(head, args);
		switch (result.safety) {
			case 'destructive': return 'high';
			case 'ambiguous': return 'medium';
			case 'safe': return 'low';
		}
	}
}

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

registerSingleton(INLShellParserService, NLShellParserService, InstantiationType.Delayed);

