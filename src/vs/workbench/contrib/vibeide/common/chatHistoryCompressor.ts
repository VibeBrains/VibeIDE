/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Simple message type for compression
type SimpleMessage = {
	role: 'user' | 'assistant' | 'system';
	content: string;
};

/**
 * Chat history compressor
 * Instead of truncating, COMPRESS old messages using summarization
 */
export class ChatHistoryCompressor {
	constructor() {}

	/**
	 * Compress chat history to fit within token limit
	 * Strategy:
	 * 1. Always keep system message + last 5 turns (uncompressed)
	 * 2. Compress middle messages using summarization
	 * 3. Drop oldest messages if still over limit
	 */
	async compressHistory(
		messages: SimpleMessage[],
		maxTokens: number,
		isLocal: boolean
	): Promise<SimpleMessage[]> {
		const currentTokens = this._estimateTokens(messages);

		if (currentTokens <= maxTokens) {
			return messages; // No compression needed
		}

		// Separate system message and conversation messages
		const systemMessage = messages.find(m => m.role === 'system');
		const conversationMessages = messages.filter(m => m.role !== 'system');

		// Keep last 5 turns uncompressed (5 user + 5 assistant = 10 messages)
		const recentTurns = conversationMessages.slice(-10);
		const oldTurns = conversationMessages.slice(0, -10);

		// Compress old turns if they exist
		let compressed: SimpleMessage[] = [];
		if (oldTurns.length > 0) {
			try {
				const summary = await this._summarizeMessages(oldTurns, isLocal);
				compressed = [{
					role: 'system',
					content: `Previous conversation summary: ${summary}`
				}];
			} catch (error) {
				console.warn('[ChatHistoryCompressor] Failed to summarize, dropping old messages:', error);
				// If summarization fails, just drop old messages
			}
		}

		// Combine: system + compressed + recent
		const result: SimpleMessage[] = [
			...(systemMessage ? [systemMessage] : []),
			...compressed,
			...recentTurns
		];

		// If still over limit, drop oldest compressed and keep only recent
		const resultTokens = this._estimateTokens(result);
		if (resultTokens > maxTokens) {
			return [
				...(systemMessage ? [systemMessage] : []),
				...recentTurns
			];
		}

		return result;
	}

	/**
	 * Summarize messages using a local model (cheap, fast)
	 * TODO: Implement proper LLM summarization when integrating with LLM service
	 */
	private async _summarizeMessages(messages: SimpleMessage[], _isLocal: boolean): Promise<string> {
		// Simplified implementation - returns a basic summary
		// In the future, this would call an LLM to generate a proper summary
		const conversationText = messages
			.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 100)}`)
			.join('\n\n');

		return `Previous conversation with ${messages.length} messages. Key topics: ${conversationText.substring(0, 200)}...`;
	}

	/**
	 * Estimate token count (rough approximation: 1 token ≈ 4 characters)
	 */
	private _estimateTokens(messages: SimpleMessage[]): number {
		const totalChars = messages.reduce((sum, msg) => {
			return sum + (msg.content?.length || 0);
		}, 0);

		// Rough estimate: 1 token ≈ 4 characters
		return Math.ceil(totalChars / 4);
	}
}

