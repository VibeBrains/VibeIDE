/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type Anthropic from '@anthropic-ai/sdk';
import { createDecorator } from '../../../instantiation/common/instantiation.js';

/**
 * Copilot API client — disabled in VibeIDE.
 *
 * Upstream talks to GitHub's CAPI backend through `@vscode/copilot-api`: it mints a Copilot
 * session token, discovers per-account endpoints and streams completions. VibeIDE ships no
 * Copilot integration, so the vendor dependency is not installed and this module keeps only
 * the shapes upstream call sites reference, plus a service that refuses every request.
 *
 * The refusal is deliberate rather than silent: nothing in VibeIDE should reach this code
 * (the agent host is not started), so being called at all is a defect worth surfacing.
 *
 * VibeIDE's own model access lives in `contrib/vibeide/electron-main/llmMessage`, where the
 * user's configured providers are called directly.
 */

/** HTTP-like status used by upstream to mark an error raised mid-stream. */
export const COPILOT_API_ERROR_STATUS_STREAMING = 520;

export interface ICopilotApiServiceRequestOptions {
	readonly headers?: Readonly<Record<string, string>>;
	readonly signal?: AbortSignal;
	readonly suppressIntegrationId?: boolean;
}

/** One chat message in a {@link ICopilotUtilityChatCompletionRequest}. */
export interface ICopilotUtilityChatMessage {
	readonly role: 'system' | 'user' | 'assistant';
	readonly content: string;
}

/** Inputs for {@link ICopilotApiService.utilityChatCompletion}. */
export interface ICopilotUtilityChatCompletionRequest {
	readonly messages: readonly ICopilotUtilityChatMessage[];
	readonly temperature?: number;
	readonly maxTokens?: number;
}

export class CopilotApiError extends Error {

	constructor(
		readonly status: number,
		readonly envelope: Anthropic.ErrorResponse,
		message?: string,
	) {
		super(message ?? envelope.error.message);
		this.name = 'CopilotApiError';
	}
}

export const ICopilotApiService = createDecorator<ICopilotApiService>('copilotApiService');

export interface ICopilotApiService {

	readonly _serviceBrand: undefined;

	/**
	 * Run a short utility completion (commit messages, session titles) through Copilot.
	 * Always rejects in VibeIDE.
	 */
	utilityChatCompletion(
		githubToken: string,
		request: ICopilotUtilityChatCompletionRequest,
		options?: ICopilotApiServiceRequestOptions,
	): Promise<string>;
}

/** Upstream injects the platform fetch here; kept so construction sites still type-check. */
export type FetchFunction = typeof globalThis.fetch;

const UNAVAILABLE = 'The Copilot API is not available in VibeIDE.';

export class CopilotApiService implements ICopilotApiService {

	declare readonly _serviceBrand: undefined;

	constructor(_fetchFn?: FetchFunction) {
		// no client is built: nothing is ever sent
	}

	async utilityChatCompletion(): Promise<string> {
		throw new Error(UNAVAILABLE);
	}
}
