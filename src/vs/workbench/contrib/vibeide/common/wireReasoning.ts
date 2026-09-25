/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The reasoning part of a request, per wire.
 *
 * One choice — the model's slider and its on/off switch — is spelled differently by each vendor: Anthropic
 * takes `thinking` plus `output_config.effort`, OpenAI a reasoning effort (the SDK names the field for chat
 * completions and for Responses), Google a `thinkingConfig`. These functions translate the choice into the
 * provider options of the matching AI SDK package and decide nothing else: a value the wire cannot carry is
 * left out, so the vendor default applies instead of a 400.
 */

import type { SendableReasoningInfo } from './modelCapabilities.js';

/** How Claude's adaptive thinking comes back in the stream. Mirrors `vibeide.llm.claudeThinkingDisplay`. */
export type ClaudeThinkingDisplay = 'summarized' | 'updates' | 'omitted';
export const CLAUDE_THINKING_DISPLAYS: readonly ClaudeThinkingDisplay[] = ['summarized', 'updates', 'omitted'];
/**
 * Summaries by default: the vendor default (`omitted`) streams empty thinking blocks, and on Opus 5.5 the
 * notes the model writes between tool calls land in those blocks too — the agent would say nothing for the
 * length of a long turn.
 */
export const DEFAULT_CLAUDE_THINKING_DISPLAY: ClaudeThinkingDisplay = 'summarized';
export const CLAUDE_THINKING_DISPLAY_SETTING = 'vibeide.llm.claudeThinkingDisplay';

/** The setting's value, or the default for anything else — a hand-edited typo must not reach the vendor as a 400. */
export function claudeThinkingDisplayOf(value: unknown): ClaudeThinkingDisplay {
	return CLAUDE_THINKING_DISPLAYS.find(display => display === value) ?? DEFAULT_CLAUDE_THINKING_DISPLAY;
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type ClaudeEffort = typeof CLAUDE_EFFORTS[number];

// Type aliases, not interfaces, on purpose: they must stay assignable to the SDK's JSON option type.
type ClaudeBlockBinding = {
	readonly prefixMismatchBehavior: 'drop_block';
};

/** The `providerOptions.anthropic` fields this module owns — a subset of @ai-sdk/anthropic's options. */
export type ClaudeThinkingOptions = {
	readonly thinking?:
	| { readonly type: 'enabled'; readonly budgetTokens: number }
	| { readonly type: 'adaptive'; readonly display: ClaudeThinkingDisplay; readonly blockBinding?: ClaudeBlockBinding }
	| { readonly blockBinding: ClaudeBlockBinding };
	readonly effort?: ClaudeEffort;
};

/**
 * Anthropic's thinking options for one request.
 *
 * @param dropStaleBlocks the model binds a thinking block to the conversation it was produced in (quirk
 * `reasoningBoundToModel`). Our system prompt changes between turns, so a replayed block would answer 400
 * on accounts where the vendor enforces the binding; the request asks to drop such a block instead.
 */
export function claudeThinkingOptions(reasoning: SendableReasoningInfo, display: ClaudeThinkingDisplay, dropStaleBlocks: boolean): ClaudeThinkingOptions {
	const blockBinding: ClaudeBlockBinding | undefined = dropStaleBlocks ? { prefixMismatchBehavior: 'drop_block' } : undefined;
	if (reasoning?.type === 'budget_slider_value') {
		return { thinking: { type: 'enabled', budgetTokens: reasoning.reasoningBudget } };
	}
	if (reasoning?.type === 'effort_slider_value') {
		const effort = CLAUDE_EFFORTS.find(level => level === reasoning.reasoningEffort);
		return {
			thinking: { type: 'adaptive', display, ...(blockBinding ? { blockBinding } : {}) },
			...(effort ? { effort } : {}),
		};
	}
	// Reasoning off, or a model without it: no thinking mode is named, exactly as before. The binding request
	// still goes out on its own — the SDK sends it without changing the model's default mode.
	return blockBinding ? { thinking: { blockBinding } } : {};
}

/** Thinking budget per level for a route whose model thinks with a budget — VibeIDEA's numbers, `ReasoningMode.budgetTokens` */
const COMPATIBLE_THINKING_BUDGET = { low: 2_000, medium: 8_000, high: 24_000 } as const;

/**
 * Thinking options for a route on the Anthropic wire that is not Anthropic's own API — OpenCode Zen, a gateway, MiniMax
 * or MiMo on their `/v1/messages`, a provider from a file
 *
 * The spelling follows the model, as in VibeIDEA: a model with the `adaptiveThinking` quirk (Claude 5) gets the adaptive
 * mode with the effort word, any other one `enabled` with a token budget. A budget slider gives its value; an effort
 * slider gives a budget by the position of the chosen word — first is low, last is high, the rest medium, since a
 * vendor's words need not be ours. Reasoning off, or a model that declares none, names no thinking at all: an «off» of
 * its own goes in the body (`reasoning.off`), and inventing one would be guessing at the vendor's format
 */
export function compatibleClaudeThinkingOptions(reasoning: SendableReasoningInfo, display: ClaudeThinkingDisplay, adaptive: boolean, effortWords: readonly string[] | undefined): ClaudeThinkingOptions {
	if (!reasoning?.isReasoningEnabled) {
		return {};
	}
	if (adaptive) {
		const effort = reasoning.type === 'effort_slider_value' ? CLAUDE_EFFORTS.find(level => level === reasoning.reasoningEffort) : undefined;
		return { thinking: { type: 'adaptive', display }, ...(effort ? { effort } : {}) };
	}
	if (reasoning.type === 'budget_slider_value') {
		return { thinking: { type: 'enabled', budgetTokens: reasoning.reasoningBudget } };
	}
	const words = effortWords ?? [];
	const at = words.indexOf(reasoning.reasoningEffort ?? '');
	const level = at < 0 || words.length < 2 ? 'medium' : at === 0 ? 'low' : at === words.length - 1 ? 'high' : 'medium';
	return { thinking: { type: 'enabled', budgetTokens: COMPATIBLE_THINKING_BUDGET[level] } };
}

/**
 * The reasoning effort for @ai-sdk/openai, on chat completions and Responses alike.
 *
 * «Off» sends the model's own off value when it has one (GPT-6 Sol and Luna: `none`). Without it nothing is
 * sent and the server applies its default — `medium` on those models — so the switch would read off and run on.
 */
export function openAIReasoningEffort(reasoning: SendableReasoningInfo, reasoningOff: boolean, offEffort: string | undefined): string | undefined {
	if (reasoning?.type === 'effort_slider_value') {
		return reasoning.reasoningEffort;
	}
	return reasoningOff ? offEffort : undefined;
}

const GOOGLE_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
type GoogleThinkingLevel = typeof GOOGLE_THINKING_LEVELS[number];

/** Gemini's `thinkingConfig`: a token budget on 2.5, a level on 3.x. */
export type GoogleThinkingConfig = {
	readonly thinkingBudget?: number;
	readonly thinkingLevel?: GoogleThinkingLevel;
};

/** Gemini's thinking config for one request; a level the wire does not know goes out as nothing, not as a 400. */
export function googleThinkingConfig(reasoning: SendableReasoningInfo): GoogleThinkingConfig | undefined {
	if (reasoning?.type === 'budget_slider_value') {
		return { thinkingBudget: reasoning.reasoningBudget };
	}
	if (reasoning?.type === 'effort_slider_value') {
		const lower = reasoning.reasoningEffort.toLowerCase();
		const thinkingLevel = GOOGLE_THINKING_LEVELS.find(level => level === lower);
		return thinkingLevel ? { thinkingLevel } : undefined;
	}
	return undefined;
}
