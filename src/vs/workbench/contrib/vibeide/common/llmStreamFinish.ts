/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the end of a model stream means for the answer it carried.
 *
 * Two things the AI SDK stream reports and nobody used to read: why the model stopped, and the thinking
 * blocks Claude signs so they can be replayed. Both are pure bookkeeping over stream parts, kept here so
 * they can be tested without a network.
 */

import { localize } from '../../../../nls.js';
import type { AnthropicReasoning, LLMFinishNotice } from './sendLLMMessageTypes.js';

/** `providerMetadata.anthropic` as the stream carries it; everything optional, read defensively. */
interface AnthropicStreamMetadata {
	readonly signature?: unknown;
	readonly redactedData?: unknown;
	readonly stopDetails?: { readonly type?: unknown; readonly category?: unknown; readonly explanation?: unknown };
}

function anthropicMetadataOf(providerMetadata: unknown): AnthropicStreamMetadata | undefined {
	const anthropic = (providerMetadata as { anthropic?: unknown } | undefined)?.anthropic;
	return anthropic && typeof anthropic === 'object' ? anthropic as AnthropicStreamMetadata : undefined;
}

/** The vendor's raw reason for a reply cut by the context window rather than by its own token limit. */
const CONTEXT_WINDOW_STOP = 'model_context_window_exceeded';

/**
 * The notice an answer carries, from the SDK's unified finish reason and the vendor's raw one.
 *
 * `content-filter` is a refusal — Anthropic names the classifier's category (`cyber`, `bio`,
 * `reasoning_extraction`, …) in `stopDetails`. `length` is a reply cut short; the raw reason tells the
 * output limit from a full context window, which the SDK folds into the same word. Anything else ended
 * normally, as far as the reader is concerned.
 */
export function finishNoticeOf(finishReason: string | null | undefined, rawFinishReason: string | undefined, providerMetadata: unknown): LLMFinishNotice | undefined {
	if (finishReason === 'content-filter') {
		const details = anthropicMetadataOf(providerMetadata)?.stopDetails;
		return {
			kind: 'refusal',
			...(typeof details?.category === 'string' ? { category: details.category } : {}),
			...(typeof details?.explanation === 'string' ? { explanation: details.explanation } : {}),
		};
	}
	if (finishReason === 'length') {
		return { kind: 'truncated', by: rawFinishReason === CONTEXT_WINDOW_STOP ? 'context-window' : 'output-limit' };
	}
	return undefined;
}

interface CollectedBlock {
	text: string;
	signature?: string;
	redactedData?: string;
}

/**
 * Thinking blocks on the Anthropic wire, rebuilt from the stream so they can go back verbatim on the next turn.
 *
 * Claude signs a block with a signature that arrives last, or sends the opaque data of a redacted block.
 * Text may be empty: under the `omitted` display a signed block carries no words and is still valid.
 * Kimi, MiMo and DeepSeek on their own `/v1/messages` never sign, and demand their reasoning back all the same:
 * an unsigned block with text is kept too.
 * Which blocks go back to whom is decided at the wire (`replaysThinkingBlock`): Claude gets only signed ones,
 * since an unsigned block from Claude is a stream cut short, and replaying it is a 400.
 */
export class AnthropicReasoningCollector {
	private readonly _blocks = new Map<string, CollectedBlock>();

	start(id: string, providerMetadata: unknown): void {
		const redactedData = anthropicMetadataOf(providerMetadata)?.redactedData;
		this._blocks.set(id, { text: '', ...(typeof redactedData === 'string' ? { redactedData } : {}) });
	}

	/** The signature arrives as a delta with no text; it is taken from whichever part carries it. */
	delta(id: string, text: string, providerMetadata: unknown): void {
		let block = this._blocks.get(id);
		if (!block) {
			block = { text: '' };
			this._blocks.set(id, block);
		}
		block.text += text;
		this._takeSignature(block, providerMetadata);
	}

	end(id: string, providerMetadata: unknown): void {
		const block = this._blocks.get(id);
		if (block) {
			this._takeSignature(block, providerMetadata);
		}
	}

	/** Whole blocks in stream order, or null when there are none — the shape `onFinalMessage` carries. */
	blocks(): AnthropicReasoning[] | null {
		const out: AnthropicReasoning[] = [];
		for (const block of this._blocks.values()) {
			if (block.redactedData !== undefined) {
				out.push({ type: 'redacted_thinking', data: block.redactedData });
			} else if (block.signature !== undefined) {
				out.push({ type: 'thinking', thinking: block.text, signature: block.signature });
			} else if (block.text.length > 0) {
				out.push({ type: 'thinking', thinking: block.text });
			}
		}
		return out.length > 0 ? out : null;
	}

	private _takeSignature(block: CollectedBlock, providerMetadata: unknown): void {
		const signature = anthropicMetadataOf(providerMetadata)?.signature;
		if (typeof signature === 'string' && signature.length > 0) {
			block.signature = signature;
		}
	}
}

/**
 * The chat notice for an answer that did not end on its own, one thought per line. Built from the notice's
 * fields — the text is for the reader, nothing downstream decides by it.
 */
export function describeFinishNotice(notice: LLMFinishNotice): string {
	const lines: string[] = [];
	if (notice.kind === 'refusal') {
		lines.push(notice.category
			? localize('vibeide.finish.refusalWithCategory', "**Модель отказалась продолжать:** сработал фильтр безопасности вендора ({0})", notice.category)
			: localize('vibeide.finish.refusal', "**Модель отказалась продолжать:** сработал фильтр безопасности вендора"));
		if (notice.explanation) {
			lines.push(notice.explanation);
		}
		return lines.join('\n\n');
	}
	if (notice.kind === 'stalled') {
		lines.push(localize('vibeide.finish.stalled', "**Поток ответа замолчал и был прерван**"));
		lines.push(localize('vibeide.finish.stalledShown', "Показано то, что успело прийти"));
	} else if (notice.by === 'context-window') {
		lines.push(localize('vibeide.finish.contextWindow', "**Ответ оборван: переполнено окно контекста модели**"));
		lines.push(localize('vibeide.finish.contextWindowHint', "Сожмите историю или выберите модель с окном больше"));
	} else {
		lines.push(localize('vibeide.finish.outputLimit', "**Ответ оборван лимитом вывода модели**"));
		lines.push(localize('vibeide.finish.outputLimitHint', "Модель не договорила — продолжите ход или поднимите лимит вывода модели"));
	}
	if (notice.cutToolName) {
		lines.push(localize('vibeide.finish.cutToolCall', "Вызов инструмента `{0}` оборван посреди аргументов и не выполнен", notice.cutToolName));
	}
	return lines.join('\n\n');
}
