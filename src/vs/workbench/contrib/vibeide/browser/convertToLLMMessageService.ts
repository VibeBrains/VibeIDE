/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatMessage, ChatImageAttachment } from '../common/chatThreadServiceTypes.js';
import { recordChatTrace } from './vibeChatRunTrace.js';
import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';

// Use VS Code's built-in base64 encoding (tested, optimized, handles edge cases)
function uint8ArrayToBase64(data: Uint8Array): string {
	if (!data || data.length === 0) {
		vibeLog.error('convertToLLMMessage', '[uint8ArrayToBase64] Empty or null data provided', { dataLength: data?.length ?? 0 });
		throw new Error('Cannot encode empty data to base64');
	}

	try {
		const buffer = VSBuffer.wrap(data);
		if (!buffer || buffer.byteLength === 0) {
			vibeLog.error('convertToLLMMessage', '[uint8ArrayToBase64] VSBuffer is empty', { originalLength: data.length });
			throw new Error('VSBuffer is empty after wrapping');
		}

		const base64 = encodeBase64(buffer, true, false); // padded = true, urlSafe = false

		if (!base64 || base64.length === 0) {
			vibeLog.error('convertToLLMMessage', '[uint8ArrayToBase64] encodeBase64 returned empty string', {
				bufferLength: buffer.byteLength,
				dataLength: data.length
			});
			throw new Error('encodeBase64 returned empty string');
		}

		// OpenAI requires clean base64 without any whitespace or newlines
		// Remove any potential whitespace (though encodeBase64 shouldn't add any)
		const cleaned = base64.trim().replace(/\s+/g, '');

		if (cleaned.length === 0) {
			vibeLog.error('convertToLLMMessage', '[uint8ArrayToBase64] Base64 became empty after cleaning', {
				original: base64.substring(0, 50),
				originalLength: base64.length
			});
			throw new Error('Base64 became empty after cleaning whitespace');
		}

		return cleaned;
	} catch (error) {
		vibeLog.error('convertToLLMMessage', '[uint8ArrayToBase64] Encoding failed', {
			error: error instanceof Error ? error.message : String(error),
			dataLength: data.length,
			dataType: data.constructor.name
		});
		throw error;
	}
}
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities } from '../common/modelCapabilities.js';
import { reParsedToolXMLString, chat_systemMessage, chat_systemMessage_local, systemToolsXMLPrompt } from '../common/prompt/prompts.js';
import { detectModelFamily } from '../common/prompt/modelFamily.js';
import { computeLastExchangePinSet } from '../common/prompt/lastExchangePin.js';
import { isPinnedContextMessage } from '../common/prompt/pinnedContext.js';
import { pickHeaviestTrimmableIndex } from '../common/prompt/contextTrim.js';
import { IVibeProjectRulesService } from './vibeProjectRulesService.js';
import { extractToolFilePaths, toWorkspaceRelative, parseRuleInvocations } from '../common/prompt/ruleFrontmatter.js';
import { planBudgetFillTail } from '../common/agentLoopHeuristics.js';
import { updateTokenCalibration, clampTokenCalibration, serializeCalibration, deserializeCalibration, TOKEN_CALIBRATION_MAX } from '../common/tokenCalibration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { localize } from '../../../../nls.js';

/** APPLICATION-scope storage key for persisted per-(provider×model) token-calibration factors. */
const TOKEN_CALIBRATION_STORAGE_KEY = 'vibeide.chat.tokenCalibrationFactors';
import { AnthropicLLMChatMessage, AnthropicReasoning, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, OpenAILLMChatMessage, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { ChatMode, FeatureName, ModelSelection, ProviderName } from '../common/vibeideSettingsTypes.js';
import { isLocalProvider } from '../common/isLocalProvider.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { IVibeideModelService } from '../common/vibeideModelService.js';
import { URI } from '../../../../base/common/uri.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { ToolName } from '../common/toolsServiceTypes.js';
import { IMCPService } from '../common/mcpService.js';
import { IRepoIndexerService, QueryMetrics } from './repoIndexerService.js';
import { IMemoriesService } from '../common/memoriesService.js';
import { IVibeSkillsLibraryService } from '../common/vibeSkillsLibraryService.js';
import { IVibeSlashCommandService } from '../common/vibeSlashCommandService.js';
import { IAuditLogService } from '../common/auditLogService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { VIBE_DOTVIBE_AGENT_PLAYBOOK } from '../common/vibeDotVibeAgentPlaybook.js';
import { IVibeContextGuardService } from './vibeContextGuardService.js';
import { IRemoteCatalogService } from '../common/remoteCatalogService.js';
import { buildResponseLanguageDirective } from '../common/vibeAgentResponseLanguageConfiguration.js';

export const EMPTY_MESSAGE = '(empty message)';

// Thrown by prepareLLMChatMessages when even aggressive trimming (head summary,
// tail tool-output elision, oldest-tail drops) cannot fit the request under the
// model's context window. Callers should surface this to the user instead of
// letting the request fly and fail later as an empty/oversized response.
export class ContextOverflowError extends Error {
	readonly info: { provider: string; model: string; finalTokens: number; contextWindow: number };
	constructor(info: { provider: string; model: string; finalTokens: number; contextWindow: number }) {
		super(`Context overflow: ${info.finalTokens.toLocaleString()} tokens > ${info.contextWindow.toLocaleString()} window for ${info.provider}/${info.model}. Start a new thread or remove large attachments.`);
		this.name = 'ContextOverflowError';
		this.info = info;
	}
}



type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
	/** Honored by budget-fill truncation: a pinned message is kept verbatim instead of being
	 *  folded into <chat_summary>. Carried from ChatMessage.pinned (roadmap pin-context). */
	pinned?: boolean;
} | {
	role: 'user';
	content: string;
	images?: ChatImageAttachment[];
	pinned?: boolean;
	/** System-injected corrective nudge (carried from ChatMessage.isSyntheticNudge): NOT a real
	 *  user turn — skipped when counting "user turns" for the Step A.5 / maxTurnPairs windows. */
	isSyntheticNudge?: boolean;
} | {
	role: 'assistant';
	content: string;
	anthropicReasoning: AnthropicReasoning[] | null;
	pinned?: boolean;
	/** Free-form reasoning string captured from prior assistant turn. For
	 *  OpenAI-compatible providers that surface `reasoning_content` on response
	 *  delta (DeepSeek thinking, openCodeGo/zen-proxied reasoning models, vLLM,
	 *  liteLLM) — must be sent back in the next request's assistant message
	 *  as `reasoning_content`, otherwise the provider rejects multi-turn with
	 *  HTTP 400 "reasoning_content must be passed back". Distinct from
	 *  `anthropicReasoning` (Anthropic-only structured blocks). Optional and
	 *  empty when the model didn't produce reasoning. */
	reasoning?: string;
};



const CHARS_PER_TOKEN = 4; // assume abysmal chars per token
const TRIM_TO_LEN = 120;
// LEGACY safety clamp, originally «avoid OpenAI 30k TPM» hardcoded at 20k tokens. It SILENTLY
// crushed every message above the cap to 120-char stubs on every request regardless of the
// model's real window — busting the prompt cache each turn (the prefix mutated), erasing the
// model's memory of files it had just read (re-read loops), and bouncing `in:` between 23k/39k.
// Root cause of the 2026-06-07 sonnet incident chain. Now config-driven via
// `vibeide.chat.maxInputTokensSafety`, DEFAULT 0 = disabled: rate limits are handled properly
// by the 429 fail-fast + auto-wait pipeline, and the context-window trim above already bounds
// the payload by (contextWindow - reservedOutputTokenSpace). The constant remains only as the
// fallback for an invalid config value.
const MAX_INPUT_TOKENS_SAFETY_DEFAULT = 0;

// isLocalProvider moved to common/isLocalProvider.ts (pure, no browser deps).
// Re-exported here so existing importers of this module keep working.
export { isLocalProvider };

// Feature-specific token caps for local models (brutally small to minimize latency)
const LOCAL_MODEL_TOKEN_CAPS: Record<FeatureName, number> = {
	'Ctrl+K': 2000,      // Minimal for quick edits
	'Apply': 2000,       // Minimal for apply operations
	'Autocomplete': 1000, // Very minimal for autocomplete
	'Chat': 8192,        // More generous for chat, but still capped
	'SCM': 4096,         // Moderate for commit messages
};

// Reserved output space for local models (smaller to allow more input)
const LOCAL_MODEL_RESERVED_OUTPUT = 1024;

// Estimate tokens for images in OpenAI format
// OpenAI uses ~85 tokens per 512x512 tile, plus base overhead
// For detailed images, tokens scale with image dimensions
// Reference: https://platform.openai.com/docs/guides/vision#calculating-costs
const estimateImageTokens = (images: ChatImageAttachment[] | undefined): number => {
	if (!images || images.length === 0) { return 0; }
	let totalTokens = 0;
	for (const img of images) {
		// Base overhead per image: ~85 tokens
		totalTokens += 85;
		// Estimate tokens based on image dimensions
		// Images are resized to fit within 2048x2048, then scaled so shortest side is 768px
		// Each 512x512 tile costs ~170 tokens (85 for base + 85 for detail)
		// For a rough estimate, use image size as a proxy
		// Base64 encoding increases size by ~33%, so we estimate conservatively
		const base64Size = Math.ceil((img.size || img.data.length) * 1.33);
		// Very rough estimate: ~1 token per 100 bytes of base64 (conservative)
		// This accounts for the fact that images are tokenized more efficiently than text
		totalTokens += Math.ceil(base64Size / 100);
	}
	return totalTokens;
};




// convert messages as if about to send to openai
/*
reference - https://platform.openai.com/docs/guides/function-calling#function-calling-steps
openai MESSAGE (role=assistant):
"tool_calls":[{
	"type": "function",
	"id": "call_12345xyz",
	"function": {
	"name": "get_weather",
	"arguments": "{\"latitude\":48.8566,\"longitude\":2.3522}"
}]

openai RESPONSE (role=user):
{   "role": "tool",
	"tool_call_id": tool_call.id,
	"content": str(result)    }

also see
openai on prompting - https://platform.openai.com/docs/guides/reasoning#advice-on-prompting
openai on developer system message - https://cdn.openai.com/spec/model-spec-2024-05-08.html#follow-the-chain-of-command
*/


/** OpenAI assistant message extended with the provider-tunneled `reasoning_content` field.
 *  Some OpenAI-compatible aggregators (DeepSeek thinking, vLLM, liteLLM) require the prior
 *  assistant turn's reasoning to be roundtripped via this field; plain OpenAI/GPT ignore it. */
type OpenAIAssistantWithReasoning = (OpenAILLMChatMessage & { role: 'assistant' }) & { reasoning_content?: string };

const prepareMessages_openai_tools = (messages: SimpleLLMMessage[]): AnthropicOrOpenAILLMMessage[] => {

	const newMessages: (OpenAILLMChatMessage | OpenAIAssistantWithReasoning)[] = [];

	// Tool-call ids already emitted in this assembly. An INTERRUPTED/resumed turn can replay
	// the same tool_call id into history; a provider rejects a duplicate id in an assistant's
	// tool_calls array or a repeated tool result with "HTTP 400 ... duplicate tool_call id".
	// Track seen ids and skip the whole replayed (tool_call + tool result) pair. (Reported: abort
	// mid-tool-call → next send 400. See docs/knowledge/.../chat-interrupt-and-inject.md)
	const seenToolCallIds = new Set<string>();

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i];

		if (currMsg.role === 'user') {
			// Convert images to OpenAI format if present
			const contentParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
			const hasImages = currMsg.images && currMsg.images.length > 0;

			// Prepare text content
			let textContent = currMsg.content && currMsg.content.trim() ? currMsg.content : '';

			// Modern vision models infer intent from the user's text + image directly — verbose
			// English fallback prompts collide with non-English questions and bias the model toward
			// generic descriptions. We only add a minimal placeholder when the user supplied no text.
			if (hasImages && (!textContent || textContent.trim().length === 0)) {
				textContent = '[user attached image]';
			}

			// Add text content - for images, we always need a text part
			if (textContent) {
				contentParts.push({ type: 'text', text: textContent });
			}

			// Add images if present (OpenAI format: data URL)
			if (hasImages && currMsg.images) {
				for (const image of currMsg.images) {
					// OpenAI only supports: image/png, image/jpeg, image/gif, image/webp
					// Convert unsupported types (like SVG) to png
					let mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' = 'image/png';
					if (image.mimeType === 'image/png' || image.mimeType === 'image/jpeg' || image.mimeType === 'image/gif' || image.mimeType === 'image/webp') {
						mimeType = image.mimeType;
					} else {
						// For SVG or any other unsupported type, default to PNG
						mimeType = 'image/png';
					}

					// Validate image data is not empty and is valid
					if (!image.data) {
						vibeLog.error('convertToLLMMessage', 'Image data is null or undefined', { image: { mimeType: image.mimeType, hasData: !!image.data } });
						throw new Error('Image data is null or undefined');
					}

					// Ensure image.data is a Uint8Array
					// TypeScript knows image.data is Uint8Array from the type definition, but we validate at runtime
					// Widen to 'unknown' so the runtime-shape narrowing below is type-checked rather than bypassed.
					const data: unknown = image.data;
					let imageData: Uint8Array;

					if (data instanceof Uint8Array) {
						imageData = data;
					} else if (Array.isArray(data)) {
						imageData = new Uint8Array(data);
					} else if (typeof data === 'string') {
						// Handle base64 string (from storage deserialization)
						if (data.startsWith('__base64__:')) {
							try {
								const base64 = data.substring(11); // Remove '__base64__:' prefix
								const binaryString = atob(base64);
								const bytes = new Uint8Array(binaryString.length);
								for (let i = 0; i < binaryString.length; i++) {
									bytes[i] = binaryString.charCodeAt(i);
								}
								imageData = bytes;
							} catch (error) {
								vibeLog.error('convertToLLMMessage', 'Failed to decode base64 image data', { error, mimeType: image.mimeType });
								throw new Error('Failed to decode base64 image data from storage');
							}
						} else {
							// Regular string (shouldn't happen, but handle gracefully)
							vibeLog.error('convertToLLMMessage', 'Image data is a plain string, expected Uint8Array', {
								mimeType: image.mimeType,
								dataType: typeof data,
								dataLength: data.length
							});
							throw new Error('Image data format not supported: received plain string, expected Uint8Array or base64');
						}
					} else if (data && typeof data === 'object' && !Array.isArray(data) && !(data instanceof Uint8Array)) {
						// Handle object that might be a serialized array or have array-like properties
						// Only try to convert if it has numeric keys (indicating it was an array serialized as object)

						// `data` is narrowed to a non-null object here; view it as a string-keyed record
						// so numeric-index access below is type-checked instead of cast to `any`.
						const dataObj = data as Record<string, unknown>;

						// First, check if this object has been visited (prevent circular references)
						// We'll use a simple approach: if keys.length is reasonable (< 1M entries)
						const keys = Object.keys(dataObj);

						// Safety check: if too many keys, it's probably not image data
						if (keys.length > 10000000) {
							vibeLog.error('convertToLLMMessage', 'Image data object has too many keys, likely not image data', {
								mimeType: image.mimeType,
								keyCount: keys.length
							});
							throw new Error(`Image data object has too many keys (${keys.length}), likely not image data`);
						}

						const numericKeys = keys.filter(k => /^\d+$/.test(k));

						if (numericKeys.length > 0 && numericKeys.length === keys.length) {
							// All keys are numeric - this looks like a serialized array
							try {
								// Convert numeric-keyed object back to array
								// Find max index safely (avoid spread operator which can cause stack overflow)
								let maxIndex = -1;
								for (const k of numericKeys) {
									const idx = parseInt(k, 10);
									if (idx > maxIndex) {
										maxIndex = idx;
									}
								}

								// Limit to reasonable size to prevent stack overflow
								const maxAllowedSize = 50000000; // 50MB max
								if (maxIndex > maxAllowedSize) {
									throw new Error(`Image data too large: ${maxIndex} bytes (max ${maxAllowedSize})`);
								}

								if (maxIndex < 0) {
									throw new Error(`Invalid max index: ${maxIndex}`);
								}

								const values: number[] = [];
								// Process in chunks to avoid stack overflow
								const chunkSize = 10000;
								for (let start = 0; start <= maxIndex; start += chunkSize) {
									const end = Math.min(start + chunkSize, maxIndex + 1);
									for (let i = start; i < end; i++) {
										// Use hasOwnProperty check to avoid getters/prototype issues
										if (Object.prototype.hasOwnProperty.call(dataObj, String(i))) {
											const val = dataObj[String(i)];
											if (typeof val === 'number' && val >= 0 && val <= 255 && Number.isInteger(val)) {
												values.push(val);
											} else if (val !== undefined && val !== null) {
												throw new Error(`Invalid byte value at index ${i}: ${val} (type: ${typeof val})`);
											} else {
												// Missing index - this might be a sparse array, fill with 0 or skip
												// For image data, we probably want to preserve indices, so skip for now
												// values.push(0); // or skip
											}
										}
									}
								}

								if (values.length === 0) {
									throw new Error('No valid byte values found in object');
								}

								imageData = new Uint8Array(values);
							} catch (error) {
								vibeLog.error('convertToLLMMessage', 'Failed to convert object to Uint8Array', {
									error: error instanceof Error ? error.message : String(error),
									mimeType: image.mimeType,
									keyCount: keys.length,
									numericKeyCount: numericKeys.length,
									sampleKeys: keys.slice(0, 5)
								});
								throw new Error(`Image data is an object that cannot be converted to Uint8Array: ${error instanceof Error ? error.message : String(error)}`);
							}
						} else {
							// Unknown object structure - doesn't look like serialized array
							const dataType = typeof data;
							const constructorName = dataObj.constructor?.name;

							vibeLog.error('convertToLLMMessage', 'Image data has invalid object structure', {
								mimeType: image.mimeType,
								dataType: dataType,
								constructor: constructorName,
								totalKeys: keys.length,
								numericKeys: numericKeys.length,
								sampleKeys: keys.slice(0, 10),
								sampleNumericKeys: numericKeys.slice(0, 5)
							});

							// Instead of throwing immediately, check if we can access the data differently
							// Maybe it's a VSBuffer or similar object?
							const hasBuffer = Object.hasOwn(dataObj, 'buffer');
							const hasByteLength = Object.hasOwn(dataObj, 'byteLength');
							if (hasBuffer || hasByteLength) {
								vibeLog.error('convertToLLMMessage', 'Object appears to be a Buffer-like object but conversion failed', {
									hasBuffer,
									hasByteLength
								});
							}

							throw new Error(`Image data has invalid object structure: ${constructorName || 'unknown'} (${keys.length} keys, ${numericKeys.length} numeric)`);
						}
					} else {
						// Unknown type
						const dataType = typeof data;
						vibeLog.error('convertToLLMMessage', 'Image data has completely invalid type', {
							mimeType: image.mimeType,
							dataType: dataType
						});
						throw new Error(`Image data has invalid type: ${dataType}, expected Uint8Array`);
					}

					// Validate image data is not empty
					if (imageData.length === 0) {
						vibeLog.error('convertToLLMMessage', 'Image data array is empty', { mimeType: image.mimeType });
						throw new Error('Image data is empty');
					}

					// Check image size (OpenAI limit is 20MB, but we should check base64 encoded size)
					// Base64 encoding increases size by ~33%, so check if original is under ~15MB
					const maxImageSize = 15 * 1024 * 1024; // 15MB
					if (imageData.length > maxImageSize) {
						vibeLog.error('convertToLLMMessage', `Image too large: ${imageData.length} bytes (max ${maxImageSize})`);
						throw new Error(`Image is too large: ${Math.round(imageData.length / 1024 / 1024)}MB. Maximum size is 20MB.`);
					}

					// Use VS Code's built-in base64 encoder (already tested and optimized)
					const base64 = uint8ArrayToBase64(imageData);

					// Validate base64 format - must contain only valid base64 characters
					// OpenAI is strict: base64 must be clean, no whitespace, proper padding
					if (!base64 || base64.length === 0) {
						vibeLog.error('convertToLLMMessage', 'Base64 encoding returned empty string');
						throw new Error('Failed to encode image to base64');
					}

					// Ensure base64 contains only valid characters (A-Z, a-z, 0-9, +, /, =)
					const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
					if (!base64Regex.test(base64)) {
						vibeLog.error('convertToLLMMessage', 'Base64 contains invalid characters:', base64.substring(0, 100));
						throw new Error('Invalid base64 encoding: contains invalid characters');
					}

					// Validate padding - base64 should end with 0, 1, or 2 '=' characters
					const paddingCount = (base64.match(/=+$/) || [''])[0].length;
					if (paddingCount > 2) {
						vibeLog.error('convertToLLMMessage', 'Base64 has invalid padding:', base64.substring(base64.length - 10));
						throw new Error('Invalid base64 encoding: too many padding characters');
					}

					// Construct data URL - OpenAI expects format: data:image/<type>;base64,<base64>
					// Ensure no whitespace in the final URL
					const dataUrl = `data:${mimeType};base64,${base64}`.trim();

					// Additional validation: ensure data URL is reasonable size
					if (dataUrl.length > 30 * 1024 * 1024) { // 30MB as safety limit
						vibeLog.error('convertToLLMMessage', 'Data URL too large:', dataUrl.length);
						throw new Error('Image data URL is too large');
					}

					contentParts.push({
						type: 'image_url',
						image_url: { url: dataUrl },
					});
				}
			}

			// Use array format if we have images or multiple parts, otherwise use string
			// For OpenAI, if we have images, we MUST use array format with at least text + images
			const userMsg: OpenAILLMChatMessage = {
				role: 'user',
				content: hasImages ? contentParts : (contentParts.length > 0 ? contentParts : (textContent || '')),
			};
			newMessages.push(userMsg);
			continue;
		}

		if (currMsg.role !== 'tool') {
			// Only assistant turns reach here: the user branch already `continue`d above.
			// For thinking-models surfaced via OpenAI-compatible aggregators (DeepSeek
			// thinking through openCodeGo/zen, vLLM, liteLLM), the prior assistant's
			// `reasoning_content` MUST be roundtripped in subsequent requests or the
			// provider rejects multi-turn with HTTP 400. Tunnel it through as a custom
			// field on the assistant message — plain OpenAI/GPT ignore unknown fields,
			// so this is safe to send unconditionally. (Anthropic uses anthropicReasoning
			// via prepareMessages_anthropic_tools, not this path.)
			if (currMsg.reasoning && currMsg.reasoning.trim().length > 0) {
				const withReasoning: OpenAIAssistantWithReasoning = {
					role: 'assistant',
					content: currMsg.content,
					reasoning_content: currMsg.reasoning,
				};
				newMessages.push(withReasoning);
			} else {
				newMessages.push({ role: 'assistant', content: currMsg.content });
			}
			continue;
		}

		// (currMsg.role === 'tool' from here.) Drop a replayed duplicate so the request stays valid.
		if (currMsg.id && seenToolCallIds.has(currMsg.id)) {
			vibeLog.warn('convertToLLMMessage', `Пропущен дублирующий tool_call id: ${currMsg.id} (${currMsg.name})`);
			continue;
		}
		if (currMsg.id) { seenToolCallIds.add(currMsg.id); }

		// Append tool_call to the NEAREST preceding assistant message — not just
		// the immediately previous one. OpenAI tools format permits multiple
		// tool result messages in a row when each tool_call_id resolves to a
		// tool_call in some earlier assistant.tool_calls; the assistant doesn't
		// need to be adjacent. Previously we required adjacency and skipped
		// tool results otherwise, which dropped them from the next LLM request
		// and caused minimax-style models to loop (they kept retrying because
		// they never saw their previous tool results).
		let nearestAssistant: (OpenAILLMChatMessage & { role: 'assistant' }) | OpenAIAssistantWithReasoning | undefined = undefined;
		for (let j = newMessages.length - 1; j >= 0; j--) {
			const m = newMessages[j];
			if (m.role === 'assistant') { nearestAssistant = m; break; }
			if (m.role === 'user') { break; } // user message ends the assistant→tools group
		}
		if (nearestAssistant) {
			if (!nearestAssistant.tool_calls) {
				nearestAssistant.tool_calls = [];
			}
			nearestAssistant.tool_calls.push({
				type: 'function',
				id: currMsg.id,
				function: {
					name: currMsg.name,
					arguments: JSON.stringify(currMsg.rawParams)
				}
			});
		} else {
			// Genuinely orphan tool result (no preceding assistant in the same
			// turn group). Synthesize a minimal assistant stub holding the
			// tool_call so the tool_result can still be sent. Without this the
			// LLM never sees the result, the model loops, and the agent stalls.
			const orphanStub: OpenAILLMChatMessage = {
				role: 'assistant',
				content: '',
				tool_calls: [{
					type: 'function',
					id: currMsg.id,
					function: {
						name: currMsg.name,
						arguments: JSON.stringify(currMsg.rawParams)
					}
				}]
			};
			newMessages.push(orphanStub);
		}

		// add the tool
		newMessages.push({
			role: 'tool',
			tool_call_id: currMsg.id,
			content: currMsg.content,
		});
	}
	return newMessages;

};



// convert messages as if about to send to anthropic
/*
https://docs.anthropic.com/en/docs/build-with-claude/tool-use#tool-use-examples
anthropic MESSAGE (role=assistant):
"content": [{
	"type": "text",
	"text": "<thinking>I need to call the get_weather function, and the user wants SF, which is likely San Francisco, CA.</thinking>"
}, {
	"type": "tool_use",
	"id": "toolu_01A09q90qw90lq917835lq9",
	"name": "get_weather",
	"input": { "location": "San Francisco, CA", "unit": "celsius" }
}]
anthropic RESPONSE (role=user):
"content": [{
	"type": "tool_result",
	"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
	"content": "15 degrees"
}]


Converts:
assistant: ...content
tool: (id, name, params)
->
assistant: ...content, call(name, id, params)
user: ...content, result(id, content)
*/

type AnthropicOrOpenAILLMMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage;

/** Single content block of any LLM message's array-form `content` (text, image, tool_use,
 *  tool_result, reasoning, …). Used to give a concrete, mutable element type when normalizing
 *  array content in place — a `{ type: 'text'; text: string }` block is a member of every
 *  variant, so it can be inserted/replaced without an `any` cast. */
type LLMContentBlock = Exclude<AnthropicOrOpenAILLMMessage['content'], string>[number];

const prepareMessages_anthropic_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {
	const newMessages: (AnthropicLLMChatMessage | (SimpleLLMMessage & { role: 'tool' }))[] = messages;

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i];

		// add anthropic reasoning
		if (currMsg.role === 'assistant') {
			if (currMsg.anthropicReasoning && supportsAnthropicReasoning) {
				const content = currMsg.content;
				newMessages[i] = {
					role: 'assistant',
					content: content ? [...currMsg.anthropicReasoning, { type: 'text' as const, text: content }] : currMsg.anthropicReasoning
				};
			}
			else {
				newMessages[i] = {
					role: 'assistant',
					content: currMsg.content,
					// strip away anthropicReasoning
				};
			}
			continue;
		}

		if (currMsg.role === 'user') {
			// Convert images to Anthropic format if present
			const contentParts: Array<{ type: 'text'; text: string } | { type: 'tool_result'; tool_use_id: string; content: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string } }> = [];
			const hasImages = currMsg.images && currMsg.images.length > 0;

			// Prepare text content
			let textContent = currMsg.content && currMsg.content.trim() ? currMsg.content : '';

			// Same minimal-text policy as OpenAI branch — no English boilerplate that fights the user's question.
			if (hasImages && (!textContent || textContent.trim().length === 0)) {
				textContent = '[user attached image]';
			}

			// Add text content - for images, we always need a text part
			if (textContent) {
				contentParts.push({ type: 'text', text: textContent });
			}

			// Add images if present
			if (hasImages && currMsg.images) {
				for (const image of currMsg.images) {
					// Convert Uint8Array to base64
					const base64 = uint8ArrayToBase64(image.data);
					// Anthropic SDK expects specific MIME types, cast appropriately
					const mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' =
						image.mimeType === 'image/svg+xml' ? 'image/png' :
							(image.mimeType === 'image/png' || image.mimeType === 'image/jpeg' || image.mimeType === 'image/webp' || image.mimeType === 'image/gif'
								? image.mimeType : 'image/png');
					contentParts.push({
						type: 'image',
						source: {
							type: 'base64',
							media_type: mediaType,
							data: base64,
						},
					});
				}
			}

			// Use array format if we have images or multiple parts, otherwise use string
			// For Anthropic, if we have images, we MUST use array format with at least text + images
			const userMsg: AnthropicLLMChatMessage = {
				role: 'user',
				content: hasImages ? contentParts : (contentParts.length > 0 ? contentParts : (textContent || '')),
			};
			newMessages[i] = userMsg;
			continue;
		}

		if (currMsg.role === 'tool') {
			// add anthropic tools
			const prevMsg = 0 <= i - 1 && i - 1 <= newMessages.length ? newMessages[i - 1] : undefined;

			// make it so the assistant called the tool
			if (prevMsg?.role === 'assistant') {
				if (typeof prevMsg.content === 'string') { prevMsg.content = [{ type: 'text', text: prevMsg.content }]; }
				prevMsg.content.push({ type: 'tool_use', id: currMsg.id, name: currMsg.name, input: currMsg.rawParams });
			}

			// turn each tool into a user message with tool results at the end
			newMessages[i] = {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: currMsg.id, content: currMsg.content }]
			};
			continue;
		}

	}

	// we just removed the tools
	return newMessages as AnthropicLLMChatMessage[];
};


const prepareMessages_XML_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {

	const llmChatMessages: AnthropicOrOpenAILLMMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {

		const c = messages[i];
		const next = 0 <= i + 1 && i + 1 <= messages.length - 1 ? messages[i + 1] : null;

		if (c.role === 'assistant') {
			// if called a tool (message after it), re-add its XML to the message
			// alternatively, could just hold onto the original output, but this way requires less piping raw strings everywhere
			let content: AnthropicOrOpenAILLMMessage['content'] = c.content;
			if (next?.role === 'tool') {
				content = `${content}\n\n${reParsedToolXMLString(next.name, next.rawParams)}`;
			}

			// anthropic reasoning
			if (c.anthropicReasoning && supportsAnthropicReasoning) {
				content = content ? [...c.anthropicReasoning, { type: 'text' as const, text: content }] : c.anthropicReasoning;
			}
			llmChatMessages.push({
				role: 'assistant',
				content
			});
		}
		// add user or tool to the previous user message
		else if (c.role === 'user' || c.role === 'tool') {
			if (c.role === 'tool') { c.content = `<${c.name}_result>\n${c.content}\n</${c.name}_result>`; }

			if (llmChatMessages.length === 0 || llmChatMessages[llmChatMessages.length - 1].role !== 'user') {
				// Convert images to Anthropic format if present (only for user messages)
				const contentParts: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string } }> = [];
				const hasImages = c.role === 'user' && c.images && c.images.length > 0;

				// Prepare text content
				let textContent = c.content && c.content.trim() ? c.content : '';

				// Same minimal-text policy as elsewhere — let the user's question stand on its own.
				if (hasImages && (!textContent || textContent.trim().length === 0)) {
					textContent = '[user attached image]';
				}

				// Add text content - for images, we always need a text part
				if (textContent) {
					contentParts.push({ type: 'text', text: textContent });
				}

				// Add images if present (only for user messages)
				if (hasImages && c.images) {
					for (const image of c.images) {
						// Convert Uint8Array to base64
						const base64 = uint8ArrayToBase64(image.data);
						// Anthropic SDK expects specific MIME types, cast appropriately
						const mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' =
							image.mimeType === 'image/svg+xml' ? 'image/png' :
								(image.mimeType === 'image/png' || image.mimeType === 'image/jpeg' || image.mimeType === 'image/webp' || image.mimeType === 'image/gif'
									? image.mimeType : 'image/png');
						contentParts.push({
							type: 'image',
							source: {
								type: 'base64',
								media_type: mediaType,
								data: base64,
							},
						});
					}
				}

				// For Anthropic XML tools, if we have images, we MUST use array format with at least text + images
				const userMsg: AnthropicLLMChatMessage = {
					role: 'user',
					content: hasImages ? contentParts : (contentParts.length > 0 ? contentParts : (c.content || ''))
				};
				llmChatMessages.push(userMsg);
			} else {
				// Append to existing user message
				const lastMsg = llmChatMessages[llmChatMessages.length - 1];
				if (lastMsg.role === 'user') {
					const hasImages = c.role === 'user' && c.images && c.images.length > 0;

					if (typeof lastMsg.content === 'string') {
						// If we have images, convert string content to array format
						if (hasImages && c.images) {
							const contentArray: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string } }> = [
								{ type: 'text', text: lastMsg.content + '\n\n' + (c.content || '') }
							];
							// Add images
							for (const image of c.images) {
								const base64 = uint8ArrayToBase64(image.data);
								const mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' =
									image.mimeType === 'image/svg+xml' ? 'image/png' :
										(image.mimeType === 'image/png' || image.mimeType === 'image/jpeg' || image.mimeType === 'image/webp' || image.mimeType === 'image/gif'
											? image.mimeType : 'image/png');
								contentArray.push({
									type: 'image',
									source: {
										type: 'base64',
										media_type: mediaType,
										data: base64,
									},
								});
							}
							lastMsg.content = contentArray;
						} else {
							// No images, just append text
							lastMsg.content += '\n\n' + c.content;
						}
					} else {
						// If it's already an array, append text
						const contentArray = lastMsg.content as Array<{ type: 'text'; text: string } | { type: 'tool_result'; tool_use_id: string; content: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string } }>;

						// Ensure we have a text part if images are being added
						const hasTextPart = contentArray.some(item => item.type === 'text');
						if (hasImages && c.images && !hasTextPart) {
							const imageAnalysisPrompt = 'Analyze the attached image(s). Describe what you see in detail. If this appears to be code, a UI, an error message, a diagram, or something related to software development, provide a detailed analysis and actionable insights.';
							contentArray.unshift({ type: 'text', text: imageAnalysisPrompt });
						}

						if (c.content && c.content.trim()) {
							contentArray.push({ type: 'text', text: '\n\n' + c.content });
						}
						// Also append images if any (only for user messages)
						if (hasImages && c.images) {
							for (const image of c.images) {
								const base64 = uint8ArrayToBase64(image.data);
								// Anthropic SDK expects specific MIME types, cast appropriately
								const mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' =
									image.mimeType === 'image/svg+xml' ? 'image/png' :
										(image.mimeType === 'image/png' || image.mimeType === 'image/jpeg' || image.mimeType === 'image/webp' || image.mimeType === 'image/gif'
											? image.mimeType : 'image/png');
								contentArray.push({
									type: 'image',
									source: {
										type: 'base64',
										media_type: mediaType,
										data: base64,
									},
								});
							}
						}
					}
				}
			}
		}
	}
	return llmChatMessages;
};


// --- CHAT ---

const prepareOpenAIOrAnthropicMessages = ({
	messages: messages_,
	systemMessage,
	aiInstructions,
	supportsSystemMessage,
	specialToolFormat,
	supportsAnthropicReasoning,
	contextWindow,
	reservedOutputTokenSpace,
	maxInputTokensSafety,
}: {
	messages: SimpleLLMMessage[];
	systemMessage: string;
	aiInstructions: string;
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated';
	specialToolFormat: 'openai-style' | 'anthropic-style' | undefined;
	supportsAnthropicReasoning: boolean;
	contextWindow: number;
	reservedOutputTokenSpace: number | null | undefined;
	/** Hard input-token cap for the legacy safetyTrim (0 = disabled). See MAX_INPUT_TOKENS_SAFETY_DEFAULT. */
	maxInputTokensSafety?: number;
}): { messages: AnthropicOrOpenAILLMMessage[]; separateSystemMessage: string | undefined } => {

	reservedOutputTokenSpace = Math.max(
		contextWindow * 1 / 2, // reserve at least 1/2 of the token window for output (comment was stale: said 1/4)
		reservedOutputTokenSpace ?? 4_096 // defaults to 4096
	);
	// Optimized: shallow clone + selective deep clone only for mutable fields
	// Images (Uint8Array) are large and don't need cloning since we won't mutate them
	let messages: (SimpleLLMMessage | { role: 'system'; content: string })[] = messages_.map(msg => {
		if (msg.role === 'user' && msg.images) {
			// Shallow clone but keep images reference (we don't mutate images)
			return { ...msg, images: msg.images };
		}
		// For other messages, shallow clone is sufficient since content is string
		return { ...msg };
	}) as (SimpleLLMMessage | { role: 'system'; content: string })[];

	// ================ system message ================
	// System message is assembled here and prepended to `messages` as `role: 'system'`.
	// Subsequent trim/compaction passes operate on the full array; the system role
	// is split back out near the end (line ~1036) before constructing the LLM-shape
	// `AnthropicOrOpenAILLMMessage[]`. Originally this was tagged with a «complete
	// hack» comment because the system message rides through the same array as
	// chat messages; the pattern is intentional — single trim pipeline applies to
	// system + chat together.
	//
	// XML-tagged sections keep the model from confusing system context with user-attached content (e.g. images).
	const sysMsgParts: string[] = [];
	if (aiInstructions) { sysMsgParts.push(`<workspace_guidelines>\n${aiInstructions}\n</workspace_guidelines>`); }
	if (systemMessage) { sysMsgParts.push(`<assistant_instructions>\n${systemMessage}\n</assistant_instructions>`); }
	const combinedSystemMessage = sysMsgParts.join('\n\n');

	// D.16 diagnostic — split "system param arrived empty" vs "built full then trimmed".
	// `systemMessage` here is the <assistant_instructions> body (chat_systemMessage + repo_context);
	// `aiInstructions` is the <workspace_guidelines> body. If sysParamLen===0 the collapse is
	// upstream (build/cache/race); if it's full here but newSysMsgLen (below) is tiny, the trim
	// pipeline crushed it. vibeLog self-gates on level/category.
	vibeLog.debug('promptDump', 'sys assembly (pre-trim)', {
		sysParamLen: systemMessage.length,
		aiInstructionsLen: aiInstructions.length,
		combinedLen: combinedSystemMessage.length,
	});

	messages.unshift({ role: 'system', content: combinedSystemMessage });

	// ================ trim ================
	messages = messages.map(m => ({ ...m, content: m.role !== 'tool' ? m.content.trim() : m.content }));

	type MesType = (typeof messages)[0];

	// ================ fit into context ================

	// the higher the weight, the higher the desire to truncate - TRIM HIGHEST WEIGHT MESSAGES
	const alreadyTrimmedIdxes = new Set<number>();
	// Pin-protect (3074/3075): workspace guidelines (system message) and expanded /skill:
	// bodies (prepended to the last USER message) must NEVER be truncated, or the model loses
	// the procedure the user just invoked. Predicate is `isPinnedContextMessage` — it covers
	// BOTH roles and the real `<skill_invocation>` marker; the old local check only matched
	// role==='system' and a marker string ("Explicitly invoked Agent Skills") that was never
	// emitted, so a skill body with no workspace guidelines present went unpinned and got
	// chopped to TRIM_TO_LEN by safetyTrim.
	// 3074 — hard-pin the most recent assistant↔tool exchange so the trimmer never drops
	// the freshest tool_result (a just-read file), which would make the model re-read it in
	// a loop. Indices are stable: the trim loop mutates `content` in place, never reorders.
	const lastExchangePins = computeLastExchangePinSet(
		messages,
		(contextWindow - reservedOutputTokenSpace) * CHARS_PER_TOKEN
	);
	const weight = (message: MesType, messages: MesType[], idx: number) => {
		const base = message.content.length;

		// Hard pin: workspace guidelines (system) / expanded skill body (user). 3074/3075.
		// Return 0 so `_findLargestByWeight` never picks it for trimming.
		if (isPinnedContextMessage(message)) { return 0; }
		// Hard pin: most recent assistant↔tool exchange (3074). Never truncate the freshest
		// tool_result (or its tool_use turn) — losing it triggers a re-read loop.
		if (lastExchangePins.has(idx)) { return 0; }

		let multiplier: number;
		multiplier = 1 + (messages.length - 1 - idx) / messages.length; // slow rampdown from 2 to 1 as index increases
		if (message.role === 'user') {
			multiplier *= 1;
		}
		else if (message.role === 'system') {
			multiplier *= .01; // very low weight
		}
		else {
			multiplier *= 10; // llm tokens are far less valuable than user tokens
		}

		// any already modified message should not be trimmed again
		if (alreadyTrimmedIdxes.has(idx)) {
			multiplier = 0;
		}
		// 1st and last messages should be very low weight
		if (idx <= 1 || idx >= messages.length - 1 - 3) {
			multiplier *= .05;
		}
		return base * multiplier;
	};

	// D.16: selection is delegated to the pure, unit-tested `pickHeaviestTrimmableIndex` (returns -1
	// when every message is weight 0 = pinned/empty, so the trim loops never crush the system).
	const _findLargestByWeight = (messages_: MesType[]) =>
		pickHeaviestTrimmableIndex(messages.map((m, i) => weight(m, messages_, i)));

	let totalLen = 0;
	for (const m of messages) { totalLen += m.content.length; }
	const charsNeedToTrim = totalLen - Math.max(
		(contextWindow - reservedOutputTokenSpace) * CHARS_PER_TOKEN, // can be 0, in which case charsNeedToTrim=everything, bad
		5_000 // ensure we don't trim at least 5k chars (just a random small value)
	);


	// <----------------------------------------->
	// 0                      |    |             |
	//                        |    contextWindow |
	//                     contextWindow - maxOut|putTokens
	//                                          totalLen
	let remainingCharsToTrim = charsNeedToTrim;
	let i = 0;
	// NO SILENT TRIMS: this context-budget loop rewrites history (truncates the heaviest
	// messages to TRIM_TO_LEN-char stubs). If it fires, say so — silent history rewrites
	// caused the 2026-06-07 cache-death incident that took a day to localize.
	let budgetTrimCrushed = 0;
	let budgetTrimCharsCut = 0;

	while (remainingCharsToTrim > 0) {
		i += 1;
		if (i > 100) { break; }

		const trimIdx = _findLargestByWeight(messages);
		if (trimIdx === -1) { break; } // D.16: nothing trimmable (all pinned) — stop rather than crush the system
		const m = messages[trimIdx];

		// if can finish here, do
		const numCharsWillTrim = m.content.length - TRIM_TO_LEN;
		if (numCharsWillTrim > remainingCharsToTrim) {
			// trim remainingCharsToTrim + '...'.length chars
			const beforeLen = m.content.length;
			m.content = m.content.slice(0, m.content.length - remainingCharsToTrim - '...'.length).trim() + '...';
			budgetTrimCrushed += 1;
			budgetTrimCharsCut += (beforeLen - m.content.length);
			break;
		}

		remainingCharsToTrim -= numCharsWillTrim;
		const beforeLen = m.content.length;
		m.content = m.content.substring(0, TRIM_TO_LEN - '...'.length) + '...';
		budgetTrimCrushed += 1;
		budgetTrimCharsCut += (beforeLen - m.content.length);
		alreadyTrimmedIdxes.add(trimIdx);
	}
	if (budgetTrimCrushed > 0) {
		vibeLog.warn('ContextGuard', `Context-budget trim crushed ${budgetTrimCrushed} message(s) to ${TRIM_TO_LEN} chars (~${budgetTrimCharsCut.toLocaleString()} chars cut to fit the context window).`);
	}

	// ================ safety clamp to avoid TPM overage ================
	// After context-based trimming, also enforce a hard upper bound on total input size
	// This accounts for text tokens, image tokens, system messages, tool definitions, and message structure overhead
	const safetyTrim = () => {
		// Disabled by default (0): see MAX_INPUT_TOKENS_SAFETY_DEFAULT — this clamp used to
		// silently crush history to 120-char stubs above a hardcoded 20k tokens.
		const inputCap = (typeof maxInputTokensSafety === 'number' && Number.isFinite(maxInputTokensSafety) && maxInputTokensSafety > 0)
			? Math.floor(maxInputTokensSafety)
			: MAX_INPUT_TOKENS_SAFETY_DEFAULT;
		if (inputCap <= 0) { return; }
		// Estimate total tokens: text content + images + system message overhead
		let textChars = 0;
		let imageTokens = 0;
		for (const m of messages) {
			textChars += m.content.length;
			// Check if message has images (only the user-role SimpleLLMMessage carries them)
			if (m.role === 'user' && m.images) {
				imageTokens += estimateImageTokens(m.images);
			}
		}

		// Add system message tokens (will be added separately or prepended)
		const systemMessageTokens = Math.ceil(combinedSystemMessage.length / CHARS_PER_TOKEN);

		// Message structure overhead: JSON formatting, role names, etc.
		// Estimate ~8 tokens per message for structure (role, content wrapper, etc.)
		const messageStructureOverhead = messages.length * 8;

		// Native tool definitions overhead (when using openai-style, tools are sent separately)
		// Conservative estimate: ~500-2000 tokens depending on number of tools
		// Since we don't have tool info here, use a conservative buffer
		const nativeToolDefinitionsOverhead = specialToolFormat === 'openai-style' ? 1000 : 0;

		// Total estimated tokens
		const textTokens = Math.ceil(textChars / CHARS_PER_TOKEN);
		const totalEstimatedTokens = textTokens + imageTokens + systemMessageTokens + messageStructureOverhead + nativeToolDefinitionsOverhead;

		// If we're under the limit, no need to trim
		if (totalEstimatedTokens <= inputCap) { return; }

		// Need to trim more aggressively
		const excessTokens = totalEstimatedTokens - inputCap;
		const excessChars = excessTokens * CHARS_PER_TOKEN;

		let guardLoops = 0;
		let charsTrimmed = 0;
		let messagesCrushed = 0;
		while (charsTrimmed < excessChars && guardLoops < 200) {
			guardLoops += 1;
			const trimIdx = _findLargestByWeight(messages);
			if (trimIdx === -1) { break; } // D.16: nothing trimmable (all pinned) — stop rather than crush the system
			const m = messages[trimIdx];
			if (m.content.length <= TRIM_TO_LEN) {
				// Already tiny, skip to next largest
				alreadyTrimmedIdxes.add(trimIdx);
				continue;
			}
			const before = m.content.length;
			m.content = m.content.substring(0, TRIM_TO_LEN - '...'.length) + '...';
			alreadyTrimmedIdxes.add(trimIdx);
			charsTrimmed += (before - m.content.length);
			messagesCrushed += 1;
		}
		// NEVER silent: this clamp rewrites history (cache-bust + model amnesia). If it fired,
		// say so loudly — the 2026-06-07 incident took a day to localize because it didn't.
		if (messagesCrushed > 0) {
			vibeLog.warn('ContextGuard', `safetyTrim crushed ${messagesCrushed} message(s) to ${TRIM_TO_LEN} chars (~${charsTrimmed.toLocaleString()} chars cut; cap ${inputCap} tokens, estimated ${totalEstimatedTokens}).`);
		}
	};

	safetyTrim();

	// ================ system message hack ================
	const newSysMsg = messages.shift()!.content;

	// D.16 diagnostic — did the trim pipeline shrink the system between pre-trim and here?
	// combinedSystemMessage is the pre-trim baseline (captured above at unshift time).
	if (newSysMsg.length !== combinedSystemMessage.length) {
		vibeLog.debug('promptDump', 'sys assembly (post-trim)', {
			preTrimLen: combinedSystemMessage.length,
			postTrimLen: newSysMsg.length,
			trimmedAway: combinedSystemMessage.length - newSysMsg.length,
		});
	}


	// ================ tools and anthropicReasoning ================
	// At this point `messages.shift()` removed the system entry (captured in
	// `newSysMsg`), so the remaining array satisfies the `SimpleLLMMessage[]`
	// shape (which excludes `role: 'system'` — system content travels via the
	// `separateSystemMessage` return field instead).

	let llmChatMessages: AnthropicOrOpenAILLMMessage[] = [];
	if (!specialToolFormat) { // XML tool behavior
		llmChatMessages = prepareMessages_XML_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning);
	}
	else if (specialToolFormat === 'anthropic-style') {
		llmChatMessages = prepareMessages_anthropic_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning);
	}
	else if (specialToolFormat === 'openai-style') {
		llmChatMessages = prepareMessages_openai_tools(messages as SimpleLLMMessage[]);
	}
	const llmMessages = llmChatMessages;


	// ================ system message add as first llmMessage ================

	let separateSystemMessageStr: string | undefined = undefined;

	// if supports system message
	if (supportsSystemMessage) {
		if (supportsSystemMessage === 'separated') { separateSystemMessageStr = newSysMsg; }
		else if (supportsSystemMessage === 'system-role') { llmMessages.unshift({ role: 'system', content: newSysMsg }); } // add new first message
		else if (supportsSystemMessage === 'developer-role') { llmMessages.unshift({ role: 'developer', content: newSysMsg }); } // add new first message
	}
	// if does not support system message
	else {
		const firstMsg = llmMessages[0];
		const systemMsgPrefix = `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>\n`;

		// Handle both string and array content formats
		if (typeof firstMsg.content === 'string') {
			const newFirstMessage = {
				role: 'user',
				content: systemMsgPrefix + firstMsg.content
			} as const;
			llmMessages.splice(0, 1); // delete first message
			llmMessages.unshift(newFirstMessage); // add new first message
		} else {
			// Content is an array (may contain images/text parts).
			// firstMsg.content is an array here (the string case is handled above), so the spread
			// preserves its element union and the `.type === 'text'` narrowing is type-checked.
			const contentArray = [...firstMsg.content];
			const firstTextIndex = contentArray.findIndex(c => c.type === 'text');

			if (firstTextIndex !== -1) {
				// Prepend to existing text part
				const existing = contentArray[firstTextIndex];
				const existingText = existing.type === 'text' ? existing.text : '';
				contentArray[firstTextIndex] = {
					type: 'text',
					text: systemMsgPrefix + existingText
				};
			} else {
				// No text part exists, add one at the beginning
				contentArray.unshift({
					type: 'text',
					text: systemMsgPrefix.trim()
				});
			}

			// `contentArray` carries the first message's original blocks (the system prefix was
			// merged into its text part). Re-tagging as a user message preserves the prior runtime
			// behavior; type the content as the user-message content rather than `any`.
			const newFirstMessage: AnthropicLLMChatMessage = {
				role: 'user',
				content: contentArray as (AnthropicLLMChatMessage & { role: 'user' })['content']
			};
			llmMessages.splice(0, 1); // delete first message
			llmMessages.unshift(newFirstMessage); // add new first message
		}
	}


	// ================ no empty message ================
	for (let i = 0; i < llmMessages.length; i += 1) {
		const currMsg: AnthropicOrOpenAILLMMessage = llmMessages[i];
		const nextMsg: AnthropicOrOpenAILLMMessage | undefined = llmMessages[i + 1];

		if (currMsg.role === 'tool') { continue; }

		// Detect tool-call-only assistant turn: text payload is empty, but a tool_result
		// follows (or this very message contains tool_use blocks). Per OpenAI spec the
		// assistant.content field may be empty in that case — the model's "output" is the
		// tool_calls array, not text. Some aggregator-proxied models (openCodeGo/minimax-m2.7)
		// reject continuations where prior assistant turns had a placeholder text like
		// "(empty message)" — they treat it as required model output and refuse next turn.
		// So: for tool-call-only turns we keep content as an empty string (valid spec),
		// and only fall back to EMPTY_MESSAGE for true empty text turns (no tool_calls).
		const isToolCallOnlyTurn = nextMsg?.role === 'tool'
			|| (Array.isArray(currMsg.content) && currMsg.content.some(c => c.type === 'tool_result' || c.type === 'tool_use'));

		// if content is a string, replace string with empty msg
		if (typeof currMsg.content === 'string') {
			if (!currMsg.content && !isToolCallOnlyTurn) {
				currMsg.content = EMPTY_MESSAGE;
			}
			// else: leave empty string as-is for tool-call-only turns, or keep actual text
		}
		else {
			// `currMsg.content` is an array (string case handled above). Alias it through a concrete
			// element type so in-place text-block edits below are type-checked without an `any` cast;
			// it's the same array reference, so mutations still land on the original message.
			const content = currMsg.content as LLMContentBlock[];

			// allowed to be empty if has a tool in it or following it
			if (content.find(c => c.type === 'tool_result' || c.type === 'tool_use')) {
				// Drop empty text blocks in place (same array reference as currMsg.content),
				// matching the previous filter-and-reassign behavior without a union reassignment.
				for (let k = content.length - 1; k >= 0; k--) {
					const block = content[k];
					if (block.type === 'text' && !block.text) { content.splice(k, 1); }
				}
				continue;
			}
			if (nextMsg?.role === 'tool') { continue; }

			// Check if we have images in the content array
			const hasImagesInContent = content.some(c => c.type === 'image' || c.type === 'image_url');

			// For messages with images, we need a proper text part (not empty) — but no English boilerplate.
			if (hasImagesInContent) {
				const textPartIndex = content.findIndex(c => c.type === 'text');
				const placeholder = '[user attached image]';

				if (textPartIndex === -1) {
					content.unshift({ type: 'text', text: placeholder });
				} else {
					const textPart = content[textPartIndex];
					if (textPart.type === 'text' && (!textPart.text || textPart.text.trim() === '' || textPart.text === EMPTY_MESSAGE)) {
						content[textPartIndex] = { type: 'text', text: placeholder };
					}
				}
			} else {
				// No images, just replace empty text with EMPTY_MESSAGE
				for (const c of content) {
					if (c.type === 'text') { c.text = c.text || EMPTY_MESSAGE; }
				}
			}

			// If array is completely empty, add a text entry
			if (content.length === 0) { currMsg.content = [{ type: 'text', text: EMPTY_MESSAGE }]; }
		}
	}

	return {
		messages: llmMessages,
		separateSystemMessage: separateSystemMessageStr,
	} as const;
};




type GeminiUserPart = (GeminiLLMChatMessage & { role: 'user' })['parts'][0];
type GeminiModelPart = (GeminiLLMChatMessage & { role: 'model' })['parts'][0];
const prepareGeminiMessages = (messages: AnthropicLLMChatMessage[]) => {
	let latestToolName: ToolName | undefined = undefined;
	const messages2: GeminiLLMChatMessage[] = messages.map((m): GeminiLLMChatMessage | null => {
		if (m.role === 'assistant') {
			if (typeof m.content === 'string') {
				return { role: 'model', parts: [{ text: m.content }] };
			}
			else {
				const parts: GeminiModelPart[] = m.content.map((c): GeminiModelPart | null => {
					if (c.type === 'text') {
						return { text: c.text };
					}
					else if (c.type === 'tool_use') {
						latestToolName = c.name;
						return { functionCall: { id: c.id, name: c.name, args: c.input } };
					}
					else { return null; }
				}).filter(m => !!m);
				return { role: 'model', parts, };
			}
		}
		else if (m.role === 'user') {
			if (typeof m.content === 'string') {
				return { role: 'user', parts: [{ text: m.content }] } satisfies GeminiLLMChatMessage;
			}
			else {
				const parts: GeminiUserPart[] = m.content.map((c): GeminiUserPart | null => {
					if (c.type === 'text') {
						return { text: c.text };
					}
					else if (c.type === 'image') {
						// Convert Anthropic image format to Gemini inlineData format
						return {
							inlineData: {
								mimeType: c.source.media_type,
								data: c.source.data,
							},
						};
					}
					else if (c.type === 'tool_result') {
						if (!latestToolName) { return null; }
						return { functionResponse: { id: c.tool_use_id, name: latestToolName, response: { output: c.content } } };
					}
					else { return null; }
				}).filter(m => !!m);

				// Ensure we have at least one part, and if we have images, ensure we have text.
				// Parts are local literals, so own-property checks match the previous `in` semantics.
				const hasImages = parts.some(p => Object.hasOwn(p, 'inlineData'));
				const hasText = parts.some(p => Object.hasOwn(p, 'text'));

				if (parts.length === 0) {
					parts.push({ text: '(empty message)' });
				} else if (hasImages && !hasText) {
					// If we have images but no text, prepend a text part (required by Gemini)
					parts.unshift({ text: '(empty message)' });
				}

				return { role: 'user', parts, };
			}

		}
		else { return null; }
	}).filter(m => !!m);

	return messages2;
};


const prepareMessages = (params: {
	messages: SimpleLLMMessage[];
	systemMessage: string;
	aiInstructions: string;
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated';
	specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined;
	supportsAnthropicReasoning: boolean;
	contextWindow: number;
	reservedOutputTokenSpace: number | null | undefined;
	maxInputTokensSafety?: number;
	providerName: ProviderName;
}): { messages: LLMChatMessage[]; separateSystemMessage: string | undefined } => {

	const specialFormat = params.specialToolFormat; // this is just for ts stupidness

	// if need to convert to gemini style of messaes, do that (treat as anthropic style, then convert to gemini style)
	if (params.providerName === 'gemini' || specialFormat === 'gemini-style') {
		const res = prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat === 'gemini-style' ? 'anthropic-style' : undefined });
		const messages = res.messages as AnthropicLLMChatMessage[];
		const messages2 = prepareGeminiMessages(messages);
		return { messages: messages2, separateSystemMessage: res.separateSystemMessage };
	}

	return prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat });
};




/** One labelled row of the context-composition report (see `buildContextBreakdown`). */
export interface ContextBreakdownSegment {
	readonly key: string;
	readonly label: string;
	/** Raw estimate (chars / 4) for this segment. */
	readonly tokens: number;
}

/** Composition of the prompt that would be sent for the selected model, for the Context Report command. */
export interface ContextBreakdown {
	readonly providerName: string;
	readonly modelName: string;
	/** Model context window (real tokens). 0 when unknown (auto/unresolved model and no live data). */
	readonly maxTokens: number;
	/** Learned estimate→real calibration factor for this model (1 when none/disabled). */
	readonly calibrationFactor: number;
	/** True when the model uses native function-calling — tool schemas ride the SDK, not the prompt. */
	readonly toolsViaSdk: boolean;
	readonly segments: readonly ContextBreakdownSegment[];
	/** Sum of all system-side segments (raw estimate). */
	readonly systemSideTokens: number;
	/** Conversation/history share, derived from the live total minus the system side. `undefined` on a cold thread. */
	readonly messagesTokens: number | undefined;
	/** Live calibrated total from the context guard (real tokens). `undefined` until a request ran this thread. */
	readonly liveTotalTokens: number | undefined;
}

export interface IConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	/** Build a composition breakdown of the prompt for the selected model (powers the Context Report command). Read-only — sends nothing. */
	buildContextBreakdown(modelSelection: ModelSelection | null): Promise<ContextBreakdown>;
	prepareLLMSimpleMessages: (opts: { simpleMessages: SimpleLLMMessage[]; systemMessage: string; modelSelection: ModelSelection | null; featureName: FeatureName }) => { messages: LLMChatMessage[]; separateSystemMessage: string | undefined };
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[]; chatMode: ChatMode; modelSelection: ModelSelection | null; repoIndexerPromise?: Promise<{ results: string[]; metrics: QueryMetrics } | null> }) => Promise<{ messages: LLMChatMessage[]; separateSystemMessage: string | undefined }>;
	prepareFIMMessage(opts: { messages: LLMFIMMessage; modelSelection: ModelSelection | null; featureName: FeatureName; languageId?: string }): { prefix: string; suffix: string; stopTokens: string[] };
	startRepoIndexerQuery: (chatMessages: ChatMessage[], chatMode: ChatMode) => Promise<{ results: string[]; metrics: QueryMetrics } | null>;
	/** Feed back a provider-reported prompt token count so the token-budget estimator can self-calibrate per (provider×model). No-op until a prompt has been built for that model this session. */
	recordActualPromptTokens(providerName: string, modelName: string, realPromptTokens: number): void;
}

export const IConvertToLLMMessageService = createDecorator<IConvertToLLMMessageService>('ConvertToLLMMessageService');


class ConvertToLLMMessageService extends Disposable implements IConvertToLLMMessageService {
	_serviceBrand: undefined;

	// Cache system messages to avoid rebuilding on every request
	// Optimized: Longer TTL since system messages rarely change during a session
	private _systemMessageCache: Map<string, { message: string; timestamp: number }> = new Map();
	private readonly _systemMessageCacheTTL = 120_000; // 2 minutes cache TTL (increased from 30s for better performance)

	// Token-budget self-calibration (roadmap "provider-reported usage"). Keyed by `provider:model`.
	// `_tokenCalibrationByModel` is the running EWMA estimate→real factor; `_lastRawPromptEstimate`
	// holds our raw (length/4) estimate of the LAST prompt sent for that model, paired with the
	// provider's reported promptTokens when it arrives (see recordActualPromptTokens).
	private readonly _tokenCalibrationByModel: Map<string, number> = new Map();
	private readonly _lastRawPromptEstimateByModel: Map<string, number> = new Map();
	/** R.12 — `@rule:<name>` names already warned-about (unknown rule) this session, to toast once each. */
	private readonly _warnedUnknownRules = new Set<string>();

	constructor(
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVibeideSettingsService private readonly vibeideSettingsService: IVibeideSettingsService,
		@IVibeideModelService private readonly vibeideModelService: IVibeideModelService,
		@IMCPService private readonly mcpService: IMCPService,
		@IRepoIndexerService private readonly repoIndexerService: IRepoIndexerService,
		@IMemoriesService private readonly memoriesService: IMemoriesService,
		@IVibeSkillsLibraryService private readonly skillsLibraryService: IVibeSkillsLibraryService,
		@IVibeSlashCommandService private readonly slashCommandService: IVibeSlashCommandService,
		@IAuditLogService private readonly auditLogService: IAuditLogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IVibeContextGuardService private readonly contextGuardService: IVibeContextGuardService,
		@IRemoteCatalogService private readonly remoteCatalogService: IRemoteCatalogService,
		@IStorageService private readonly storageService: IStorageService,
		@IVibeProjectRulesService private readonly projectRulesService: IVibeProjectRulesService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		// Restore persisted token-calibration factors (stable per model tokenizer) so the budget
		// estimator doesn't re-learn from scratch every window reload. Populates the existing map.
		try {
			const restored = deserializeCalibration(this.storageService.get(TOKEN_CALIBRATION_STORAGE_KEY, StorageScope.APPLICATION));
			for (const [k, v] of restored) { this._tokenCalibrationByModel.set(k, v); }
		} catch { /* corrupted blob — start fresh */ }
	}

	// Read `.vibe/rules.md` and root `AGENTS.md` from workspace folders (open-document models when attached)
	private _getVibeRulesFileContents(activation?: { userText?: string; files?: readonly string[] }): string {
		// R.0 — single source of truth: IVibeProjectRulesService combines flat `.vibe/rules.md` +
		// `AGENTS.md` AND folder rules (`.vibe/rules/**` — `.md`/`.mdc`; no foreign tools' rule dirs),
		// with per-source `[Source: path]` labels + secret-sanitize. Previously this read just the two
		// flat files inline via getModel, bypassing the service — so folder/`.mdc` rules never
		// reached the prompt (incident 2026-05-30, model hallucinated filenames). `activation`
		// (the user message) gates conditional rules (triggers/alwaysApply:false → R.7/R.3).
		try {
			return this.projectRulesService.getCombinedRules(activation);
		}
		catch (e) {
			return '';
		}
	}

	// Read `.vibe/goals.md` (open-document model). Injected as PASSIVE context so the
	// model SEES the file exists and its current content — instead of inventing a new
	// goals file (observed: minimax created `.vibe/goals/<NAME>.md`, ignoring the
	// playbook instruction to use the root file). Returns '' for the untouched template
	// (heading + comments only) so empty goals add zero prompt noise.
	private _getVibeGoalsFileContent(): string {
		try {
			const parts: string[] = [];
			for (const folder of this.workspaceContextService.getWorkspace().folders) {
				const model = this.vibeideModelService.getModel(URI.joinPath(folder.uri, '.vibe', 'goals.md')).model;
				if (!model) { continue; }
				const stripped = model.getValue(EndOfLinePreference.LF).replace(/<!--[\s\S]*?-->/g, '').trim();
				const body = stripped.replace(/^#.*$/m, '').trim(); // drop heading to test for real content
				if (body.length > 0) { parts.push(stripped); }
			}
			return parts.join('\n\n').trim();
		}
		catch (e) {
			return '';
		}
	}

	// Get combined AI instructions from settings, .vibe/rules.md, and AGENTS.md (via open models)
	private _getCombinedAIInstructions(activation?: { userText?: string; files?: readonly string[] }): string {
		const globalAIInstructions = this.vibeideSettingsService.state.globalSettings.aiInstructions;
		const vibeRulesFileContent = this._getVibeRulesFileContents(activation);

		const ans: string[] = [];
		if (globalAIInstructions) { ans.push(globalAIInstructions); }
		// Binding framing: the model otherwise treats the labeled `[Source: …]` rules block as
		// reference material, not as instructions, and ignores it (see
		// docs/knowledge/agent-collaboration/why-models-ignore-injected-rules.md). Wrap it in an
		// imperative envelope — mirrors how <session_goals> below is obeyed. Static text → no
		// effect on the system-message cache key.
		if (vibeRulesFileContent) { ans.push(`<project_rules>\nЭто ОБЯЗАТЕЛЬНЫЕ правила этого проекта. Они приоритетнее твоих дефолтов и общих инструкций; при конфликте — следуй им. Это не справка, а прямые указания — соблюдай их буквально.\n\n${vibeRulesFileContent}\n</project_rules>`); }
		if (this.workspaceContextService.getWorkspace().folders.length > 0) {
			ans.push(VIBE_DOTVIBE_AGENT_PLAYBOOK);
		}
		// Inject current .vibe/goals.md with medium-strength framing: the model should actively work
		// toward the goals and self-check against them, but they are NOT a hard contract — the user's
		// live request and <project_rules> take precedence (goals can be stale/aspirational). Keeps the
		// original "write to the ROOT file, no subfolders" instruction that fixed the invent-a-new-goals-
		// file incident. Empty/template goals.md contributes nothing.
		const sessionGoals = this._getVibeGoalsFileContent();
		if (sessionGoals) {
			ans.push(`<session_goals source=".vibe/goals.md">\nАктивные цели этой сессии — держи их в фокусе и веди работу к ним; перед завершением хода сверяйся, приблизил ли ты их. НО приоритет: живой запрос пользователя и <project_rules> важнее — если новая просьба противоречит целям, следуй просьбе и предложи обновить цели. Записывать или обновлять цели — ИМЕННО в корневой .vibe/goals.md (НЕ создавай подпапки .vibe/goals/… и не заводи отдельные файлы целей).\n\n${sessionGoals}\n</session_goals>`);
		}
		// R.x — passive referenced-files block: content of files LINKED from project rules
		// (Cursor-style `mdc:`/relative links), e.g. docs/knowledge.md. Reference material, NOT
		// directives — deliberately kept OUT of the binding <project_rules> envelope.
		const linkedRefs = this.projectRulesService.getLinkedReferences();
		if (linkedRefs) {
			ans.push(`<referenced_files>\nФайлы, на которые ссылаются правила проекта (база знаний и т.п.). Это СПРАВОЧНЫЙ материал — используй его при формировании ответов, но это НЕ обязательные директивы (в отличие от <project_rules>).\n\n${linkedRefs}\n</referenced_files>`);
		}
		return ans.join('\n\n');
	}


	// system message with caching
	private _generateChatMessagesSystemMessage = async (chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined, providerName?: string, modelName?: string) => {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath);

		const openedURIs = this.modelService.getModels().filter(m => m.isAttachedToEditor()).map(m => m.uri.fsPath) || [];
		const activeURI = this.editorService.activeEditor?.resource?.fsPath;

		const preferJsonToolArguments = this.configurationService.getValue<boolean>('vibeide.agent.preferJsonToolArguments') ?? false;

		// Create cache key from relevant factors. modelFamily is folded in so that
		// future family-specific prompt branches don't bleed across providers.
		const cacheKey = `${chatMode}|${specialToolFormat}|${providerName ?? ''}|${modelName ?? ''}|${workspaceFolders.join(',')}|${openedURIs.join(',')}|${activeURI || ''}|pj:${preferJsonToolArguments}`;

		// Check cache
		const cached = this._systemMessageCache.get(cacheKey);
		const now = Date.now();
		if (cached && (now - cached.timestamp) < this._systemMessageCacheTTL) {
			return cached.message;
		}

		const directoryStr = await this.directoryStrService.getAllDirectoriesStr({
			cutOffMessage: chatMode === 'agent' || chatMode === 'gather' || chatMode === 'plan' ?
				`...Directories string cut off, use tools to read more...`
				: `...Directories string cut off, ask user for more if necessary...`
		});

		// Native function-calling models (specialToolFormat set) receive tools via
		// the SDK's `tools:` field — duplicating them in the system prompt as XML
		// invites the model to hallucinate by-index references ("MCP tool 1"). Only
		// emit XML definitions when no native channel is available.
		const includeXMLToolDefinitions = !specialToolFormat;
		const modelFamily = detectModelFamily(providerName, modelName, specialToolFormat);

		const mcpTools = this.mcpService.getMCPTools();

		const persistentTerminalIDs = this.terminalToolService.listPersistentTerminalIds();

		// Get relevant memories for the current context (use active file and recent user messages as query)
		let relevantMemories: string | undefined;
		if (this.memoriesService.isEnabled()) {
			try {
				// Build query from active file and opened files for relevance
				const queryParts: string[] = [];
				if (activeURI) {
					const fileName = activeURI.split('/').pop() || '';
					queryParts.push(fileName);
				}
				openedURIs.forEach(uri => {
					const fileName = uri.split('/').pop() || '';
					queryParts.push(fileName);
				});
				const query = queryParts.join(' ') || 'project context';

				const memories = await this.memoriesService.getRelevantMemories(query, 5);
				if (memories.length > 0) {
					const memoryLines = memories.map(m => {
						const typeLabel = m.entry.type === 'decision' ? 'Decision' :
							m.entry.type === 'preference' ? 'Preference' :
								m.entry.type === 'recentFile' ? 'Recent File' : 'Context';
						return `- [${typeLabel}] ${m.entry.key}: ${m.entry.value}`;
					});
					relevantMemories = memoryLines.join('\n');
				}
			} catch (error) {
				// Memories unavailable, continue without them
				vibeLog.debug('convertToLLMMessage', '[ConvertToLLMMessage] Failed to get memories:', error);
			}
		}

		const systemMessage = chat_systemMessage({ workspaceFolders, openedURIs, directoryStr, activeURI, persistentTerminalIDs, chatMode, mcpTools, includeXMLToolDefinitions, relevantMemories, strictJsonToolArguments: preferJsonToolArguments, modelFamily });

		// Cache the result
		this._systemMessageCache.set(cacheKey, { message: systemMessage, timestamp: now });

		// Clean up old cache entries (keep cache size reasonable)
		if (this._systemMessageCache.size > 10) {
			for (const [key, value] of this._systemMessageCache.entries()) {
				if ((now - value.timestamp) >= this._systemMessageCacheTTL) {
					this._systemMessageCache.delete(key);
				}
			}
		}

		return systemMessage;
	};




	// --- LLM Chat messages ---

	private _chatMessagesToSimpleMessages(chatMessages: ChatMessage[]): SimpleLLMMessage[] {
		const simpleLLMMessages: SimpleLLMMessage[] = [];

		for (const m of chatMessages) {
			if (m.role === 'checkpoint') { continue; }
			if (m.role === 'interrupted_streaming_tool') { continue; }
			if (m.role === 'assistant') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.displayContent,
					anthropicReasoning: m.anthropicReasoning,
					reasoning: m.reasoning || undefined,
					pinned: m.pinned,
				});
			}
			else if (m.role === 'tool') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
					name: m.name,
					id: m.id,
					rawParams: m.rawParams,
					pinned: m.pinned,
				});
			}
			else if (m.role === 'user') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
					images: m.images,
					pinned: m.pinned,
					isSyntheticNudge: m.isSyntheticNudge,
				});
			}
		}
		return simpleLLMMessages;
	}

	recordActualPromptTokens: IConvertToLLMMessageService['recordActualPromptTokens'] = (providerName, modelName, realPromptTokens) => {
		const key = `${providerName}:${modelName}`;
		const est = this._lastRawPromptEstimateByModel.get(key);
		if (est === undefined) { return; } // no prompt built for this model yet — nothing to pair against
		const prev = this._tokenCalibrationByModel.get(key);
		const maxFactor = this.configurationService.getValue<number>('vibeide.context.tokenCalibrationMaxFactor') ?? TOKEN_CALIBRATION_MAX;
		const next = updateTokenCalibration(prev, realPromptTokens, est, maxFactor);
		this._tokenCalibrationByModel.set(key, next);
		vibeLog.debug('tokenCalibration', `${key}: real=${realPromptTokens} est=${est} factor ${(prev ?? 1).toFixed(3)} → ${next.toFixed(3)}`);
		// Persist (APPLICATION scope, MACHINE target) so the factor survives reloads. Payload is a
		// tiny JSON object keyed by provider:model; storage writes are batched by the platform.
		try {
			this.storageService.store(TOKEN_CALIBRATION_STORAGE_KEY, serializeCalibration(this._tokenCalibrationByModel), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} catch { /* non-fatal — calibration still works in-memory this session */ }
	};

	prepareLLMSimpleMessages: IConvertToLLMMessageService['prepareLLMSimpleMessages'] = ({ simpleMessages, systemMessage, modelSelection, featureName }) => {
		if (modelSelection === null) { return { messages: [], separateSystemMessage: undefined }; }

		const { overridesOfModel, settingsOfProvider } = this.vibeideSettingsService.state;

		const { providerName, modelName } = modelSelection;
		// Skip "auto" - it's not a real provider
		if (providerName === 'auto' && modelName === 'auto') {
			throw new Error('Cannot prepare messages for "auto" model selection - must resolve to a real model first');
		}
		const catalogInfo = this.remoteCatalogService.getCachedModelInfo(providerName, modelName);
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel, catalogInfo);

		const modelSelectionOptions = this.vibeideSettingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName];

		// Detect if local provider for optimizations
		const isLocal = isLocalProvider(providerName, settingsOfProvider);

		// Get combined AI instructions (skip for local edit features to reduce tokens)
		const aiInstructions = (isLocal && (featureName === 'Ctrl+K' || featureName === 'Apply'))
			? '' // Skip verbose AI instructions for local edit features
			: this._getCombinedAIInstructions();

		// Keep this method synchronous (indexer enrichment handled in Chat flow)
		const enrichedSystemMessage = systemMessage;

		const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel);
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel });

		// Apply feature-specific token caps for local models
		let effectiveContextWindow = contextWindow;
		let effectiveReservedOutput = reservedOutputTokenSpace;
		if (isLocal) {
			const featureTokenCap = LOCAL_MODEL_TOKEN_CAPS[featureName] || 4096;
			effectiveContextWindow = Math.min(effectiveContextWindow, featureTokenCap + (reservedOutputTokenSpace || LOCAL_MODEL_RESERVED_OUTPUT));
			effectiveReservedOutput = LOCAL_MODEL_RESERVED_OUTPUT; // Use smaller reserved space for locals
		}

		const { messages, separateSystemMessage } = prepareMessages({
			messages: simpleMessages,
			systemMessage: enrichedSystemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow: effectiveContextWindow,
			reservedOutputTokenSpace: effectiveReservedOutput,
			maxInputTokensSafety: this.configurationService.getValue<number>('vibeide.chat.maxInputTokensSafety') ?? 0,
			providerName,
		});
		return { messages, separateSystemMessage };
	};
	// Last REAL user message text for retrieval queries. Synthetic corrective nudges
	// (isSyntheticNudge) carry no user intent and must not key RepoIndexer retrieval —
	// observed in the sonnet stall log: queries ran against «⚙️ Авто-продолжение…»
	// instead of the actual task, degrading injected repo context.
	private _lastRealUserQuery(chatMessages: ChatMessage[]): string {
		const realUsers = chatMessages.filter((m): m is ChatMessage & { role: 'user' } => m.role === 'user' && !m.isSyntheticNudge);
		const last = realUsers[realUsers.length - 1];
		return last?.content || realUsers.map(m => m.content).join(' ').slice(0, 200);
	}

	startRepoIndexerQuery: IConvertToLLMMessageService['startRepoIndexerQuery'] = async (chatMessages, chatMode) => {
		// PERFORMANCE: Start repo indexer query early (can be done in parallel with router decision)
		if (!this.vibeideSettingsService.state.globalSettings.enableRepoIndexer) {
			return null;
		}

		const userQuery = this._lastRealUserQuery(chatMessages);
		if (!userQuery.trim()) {
			return null;
		}

		try {
			const k = chatMode === 'agent' ? 8 : 6;
			const result = await this.repoIndexerService.queryWithMetrics(userQuery, k);
			return result;
		} catch (error) {
			// Try to warm index if query failed (might not exist yet)
			this.repoIndexerService.warmIndex(undefined).catch(() => { });
			return null;
		}
	};

	// Read-only composition report for the Context Report command (vibeide.context.status).
	// Measures the same prompt pieces that prepareLLMChatMessages assembles — reusing the same
	// getters as the single source of truth — without sending anything. The conversation/history
	// share is derived as the remainder of the live (de-calibrated) total minus the measured
	// system side, which avoids importing chatThreadService here (that would close an import cycle:
	// chatThreadService → convertToLLMMessageService).
	buildContextBreakdown: IConvertToLLMMessageService['buildContextBreakdown'] = async (modelSelection) => {
		const est = (s: string | undefined | null) => Math.ceil((s?.length ?? 0) / 4);

		// Resolve capabilities only for a concrete model; tolerate auto/null so the report still
		// shows the model-agnostic composition (rules, playbook, goals, refs).
		const sel = modelSelection && modelSelection.providerName !== 'auto'
			? { providerName: modelSelection.providerName as Exclude<ProviderName, 'auto'>, modelName: modelSelection.modelName }
			: null;
		let specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined = undefined;
		let modelContextWindow = 0;
		if (sel) {
			const { overridesOfModel } = this.vibeideSettingsService.state;
			const catalogInfo = this.remoteCatalogService.getCachedModelInfo(sel.providerName, sel.modelName);
			const caps = getModelCapabilities(sel.providerName, sel.modelName, overridesOfModel, catalogInfo);
			specialToolFormat = caps.specialToolFormat;
			modelContextWindow = caps.contextWindow ?? 0;
		}

		// System frame (workspace, directory tree, environment, memories) + (for XML models) tool defs.
		const fullSystem = await this._generateChatMessagesSystemMessage('agent', specialToolFormat, sel?.providerName, sel?.modelName);
		// Native function-calling models receive tools via the SDK, NOT in the prompt. We still
		// estimate the XML tool-schema size to show how heavy the tool surface is for this model.
		const toolsStr = systemToolsXMLPrompt('agent', this.mcpService.getMCPTools());
		const toolsViaSdk = !!specialToolFormat;
		const frameTokens = Math.max(0, est(fullSystem) - (toolsViaSdk ? 0 : est(toolsStr)));

		// AI-instruction source pieces — read the SAME getters _getCombinedAIInstructions uses
		// (single source of truth). The imperative envelopes are constant framing and fold into the
		// messages remainder; the raw source contents are what actually weigh on the budget.
		const globalAIInstructions = this.vibeideSettingsService.state.globalSettings.aiInstructions;
		const vibeRules = this._getVibeRulesFileContents();
		const sessionGoals = this._getVibeGoalsFileContent();
		const linkedRefs = this.projectRulesService.getLinkedReferences();
		const hasWorkspace = this.workspaceContextService.getWorkspace().folders.length > 0;

		const segments: ContextBreakdownSegment[] = [
			{ key: 'frame', label: 'Системный промпт (каркас)', tokens: frameTokens },
			{ key: 'tools', label: toolsViaSdk ? 'Инструменты (через SDK провайдера)' : 'Инструменты (XML в промпте)', tokens: est(toolsStr) },
			{ key: 'global', label: 'Глобальные AI-инструкции (vibeide.*)', tokens: est(globalAIInstructions) },
			{ key: 'projectRules', label: 'Правила проекта <project_rules>', tokens: est(vibeRules) },
			{ key: 'playbook', label: 'Playbook (.vibe agent playbook)', tokens: hasWorkspace ? est(VIBE_DOTVIBE_AGENT_PLAYBOOK) : 0 },
			{ key: 'sessionGoals', label: 'Цели сессии <session_goals>', tokens: est(sessionGoals) },
			{ key: 'referencedFiles', label: 'Связанные файлы <referenced_files>', tokens: est(linkedRefs) },
		];
		const systemSideTokens = segments.reduce((a, s) => a + s.tokens, 0);

		// Live, calibrated fill from the context guard (authoritative; populated only after at least
		// one request in the current thread).
		const status = this.contextGuardService.getStatus();
		const calibrationMaxFactor = this.configurationService.getValue<number>('vibeide.context.tokenCalibrationMaxFactor') ?? TOKEN_CALIBRATION_MAX;
		const calibrationFactor = sel
			? clampTokenCalibration(this._tokenCalibrationByModel.get(`${sel.providerName}:${sel.modelName}`), calibrationMaxFactor)
			: 1;
		const liveTotalTokens = status.currentTokens > 0 ? status.currentTokens : undefined;
		const messagesTokens = liveTotalTokens !== undefined
			? Math.max(0, Math.round(liveTotalTokens / (calibrationFactor || 1)) - systemSideTokens)
			: undefined;
		const maxTokens = status.maxTokens > 0 ? status.maxTokens : modelContextWindow;

		return {
			providerName: sel?.providerName ?? (modelSelection?.providerName ?? 'auto'),
			modelName: sel?.modelName ?? (modelSelection?.modelName ?? 'auto'),
			maxTokens,
			calibrationFactor,
			toolsViaSdk,
			segments,
			systemSideTokens,
			messagesTokens,
			liveTotalTokens,
		};
	};

	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, modelSelection, repoIndexerPromise }) => {
		if (modelSelection === null) { return { messages: [], separateSystemMessage: undefined }; }

		const { overridesOfModel } = this.vibeideSettingsService.state;

		const { providerName, modelName } = modelSelection;
		// Skip "auto" - it's not a real provider
		if (providerName === 'auto' && modelName === 'auto') {
			throw new Error('Cannot prepare messages for "auto" model selection - must resolve to a real model first');
		}
		// At this point, TypeScript knows providerName is not "auto", but we need to assert it for the type system
		const validProviderName = providerName as Exclude<typeof providerName, 'auto'>;
		const catalogInfo = this.remoteCatalogService.getCachedModelInfo(validProviderName, modelName);
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(validProviderName, modelName, overridesOfModel, catalogInfo);

		const { disableSystemMessage } = this.vibeideSettingsService.state.globalSettings;

		// For local models, use minimal system message template instead of truncating
		const isLocal = isLocalProvider(validProviderName, this.vibeideSettingsService.state.settingsOfProvider);
		const preferJsonToolArguments = this.configurationService.getValue<boolean>('vibeide.agent.preferJsonToolArguments') ?? false;

		let systemMessage: string;
		if (disableSystemMessage) {
			systemMessage = '';
		} else if (isLocal) {
			// Use minimal local template for local models
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath);
			const openedURIs = this.editorService.editors.map(e => e.resource?.fsPath || '').filter(Boolean);
			const activeURI = this.editorService.activeEditor?.resource?.fsPath;
			const directoryStr = await this.directoryStrService.getAllDirectoriesStr({
				cutOffMessage: chatMode === 'agent' || chatMode === 'gather' || chatMode === 'plan' ?
					`...Directories string cut off, use tools to read more...`
					: `...Directories string cut off, ask user for more if necessary...`
			});
			// Same rationale as the cloud path: avoid dual-channel tool exposure
			// when the model can call tools natively. Local models typically
			// have specialToolFormat===undefined and keep the XML block.
			const includeXMLToolDefinitions = !specialToolFormat;
			const modelFamily = detectModelFamily(validProviderName, modelName, specialToolFormat);
			const mcpTools = this.mcpService.getMCPTools();
			const persistentTerminalIDs = this.terminalToolService.listPersistentTerminalIds();

			// Get relevant memories for the current context
			let relevantMemories: string | undefined;
			if (this.memoriesService.isEnabled()) {
				try {
					const queryParts: string[] = [];
					if (activeURI) {
						const fileName = activeURI.split('/').pop() || '';
						queryParts.push(fileName);
					}
					openedURIs.forEach(uri => {
						const fileName = uri.split('/').pop() || '';
						queryParts.push(fileName);
					});
					const query = queryParts.join(' ') || 'project context';
					const memories = await this.memoriesService.getRelevantMemories(query, 5);
					if (memories.length > 0) {
						const memoryLines = memories.map(m => {
							const typeLabel = m.entry.type === 'decision' ? 'Decision' :
								m.entry.type === 'preference' ? 'Preference' :
									m.entry.type === 'recentFile' ? 'Recent File' : 'Context';
							return `- [${typeLabel}] ${m.entry.key}: ${m.entry.value}`;
						});
						relevantMemories = memoryLines.join('\n');
					}
				} catch (error) {
					vibeLog.debug('convertToLLMMessage', '[ConvertToLLMMessage] Failed to get memories:', error);
				}
			}

			systemMessage = chat_systemMessage_local({ workspaceFolders, openedURIs, directoryStr, activeURI, persistentTerminalIDs, chatMode, mcpTools, includeXMLToolDefinitions, relevantMemories, strictJsonToolArguments: preferJsonToolArguments, modelFamily });
		} else {
			// Use full system message for cloud models
			systemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat, validProviderName, modelName);
		}

		// Query repo indexer if enabled - get context from the LAST user message (most relevant)
		// PERFORMANCE: Use pre-started promise if available (from parallel execution), otherwise start now
		// Prompt-caching (knowledge/roadmap/token-economy.md, A): retrieval output changes every
		// turn, so it must NOT be appended to the system message — that invalidated the provider's
		// prefix cache on every request. It rides in the last user turn instead (prepended below).
		let repoContextUserBlock = '';
		if (this.vibeideSettingsService.state.globalSettings.enableRepoIndexer && !disableSystemMessage) {
			let indexResults: string[] | null = null;
			let metrics: QueryMetrics | null = null;

			if (repoIndexerPromise) {
				// Use pre-started query (from parallel execution with router)
				try {
					const result = await repoIndexerPromise;
					if (result) {
						indexResults = result.results;
						metrics = result.metrics;
					}
				} catch (error) {
					// Fall back to starting query now if pre-started failed
					const userQuery = this._lastRealUserQuery(chatMessages);
					if (userQuery.trim()) {
						try {
							const k = chatMode === 'agent' ? 8 : 6;
							const result = await this.repoIndexerService.queryWithMetrics(userQuery, k);
							indexResults = result.results;
							metrics = result.metrics;
						} catch (err) {
							this.repoIndexerService.warmIndex(undefined).catch(() => { });
						}
					}
				}
			} else {
				// Start query now (fallback for non-auto mode or if promise not provided)
				const userQuery = this._lastRealUserQuery(chatMessages);
				if (userQuery.trim()) {
					try {
						const k = chatMode === 'agent' ? 8 : 6;
						const result = await this.repoIndexerService.queryWithMetrics(userQuery, k);
						indexResults = result.results;
						metrics = result.metrics;
					} catch (error) {
						this.repoIndexerService.warmIndex(undefined).catch(() => { });
					}
				}
			}

			if (indexResults && indexResults.length > 0) {
				const guidance = `\n\n<repo_guidance>\nYou have access to repository context via <repo_context>. Use it to answer repo-specific questions and make changes. Do not claim that you lack access to the repository or files. When asked what the repo is about, summarize based on README.md, package/product metadata, and top-level docs if present.\n\nIMPORTANT: When referencing code or files from the context, cite them explicitly using the file path and line ranges provided (e.g., "In repoIndexerService.ts:42-56, the function does..."). This helps users verify your answers and navigate to the relevant code.\n</repo_guidance>`;
				const contextSection = `\n\n<repo_context>\nHere are relevant files and symbols from the codebase:\n${indexResults.map((r, i) => `${i + 1}. ${r}`).join('\n\n')}\n</repo_context>`;
				repoContextUserBlock = (guidance + contextSection).trim();

				// Log metrics for monitoring (vibeLog self-gates on level/category)
				if (metrics) {
					const userQuery = this._lastRealUserQuery(chatMessages);
					vibeLog.debug('convertToLLMMessage', '[RepoIndexer]', {
						query: userQuery.slice(0, 50),
						latencyMs: metrics.retrievalLatencyMs.toFixed(1),
						tokens: metrics.tokensInjected,
						results: metrics.resultsCount,
						topScore: metrics.topScore?.toFixed(2),
						timedOut: metrics.timedOut,
						earlyTerminated: metrics.earlyTerminated,
						mode: chatMode
					});
				}
			} else if (!repoIndexerPromise) {
				// Index might be empty - try to warm it in background (only if we started query ourselves)
				this.repoIndexerService.warmIndex(undefined).catch(() => { });
			}
		}

		// Get model options (providerName is already validated above)
		const modelSelectionOptions = this.vibeideSettingsService.state.optionsOfModelSelection['Chat'][validProviderName]?.[modelName];

		// Get combined AI instructions + optional project skills index (discovery + implicit keyword retrieval)
		// Synthetic nudges are skipped: /skill: parsing + implicit retrieval must key off the real request.
		const lastUserForSkills = [...chatMessages].reverse().find((m): m is ChatMessage & { role: 'user' } => m.role === 'user' && !m.isSyntheticNudge);
		const lastUserTextForSkills = typeof lastUserForSkills?.content === 'string' ? lastUserForSkills.content : '';
		const skillsDiscovery = await this.skillsLibraryService.getDiscoveryText(chatMode);
		const implicitSkills = await this.skillsLibraryService.getImplicitSkillRetrievalHints(lastUserTextForSkills, chatMode);

		// Explicit `/skill:NAME` invocations — expand the full SKILL.md body via
		// IVibeSlashCommandService. The expanded body is injected as a `<skill_invocation>`
		// block PREPENDED to the last user message (not buried in the system prompt).
		// Rationale (model-stalls.md #002): models routinely ignore skill bodies placed
		// inside <workspace_guidelines> in the system prompt — they treat that as
		// "static project rules" and don't associate it with the user's `/skill:` command.
		// Placing the body in the user turn itself gives the model an unambiguous
		// "this is what you should follow for THIS request" signal. Pattern matches
		// Cursor/Kilo/Claude Code behaviour. Up to 3 unique skills per message.
		const explicitSkillIdsForExpand = Array.from(new Set(
			[...lastUserTextForSkills.matchAll(/\/skill:\s*([\w.-]+)/gi)].map(m => m[1])
		)).slice(0, 3);

		vibeLog.debug('Skill', 'expand intercept', { lastUserSnippet: lastUserTextForSkills.slice(0, 100), foundIds: explicitSkillIdsForExpand });
		const explicitSkillBodies: Array<{ id: string; body: string }> = [];
		if (explicitSkillIdsForExpand.length > 0) {
			for (const skillId of explicitSkillIdsForExpand) {
				try {
					const expanded = await this.slashCommandService.expand(`/skill:${skillId}`);

					vibeLog.debug('Skill', 'expand result', { skillId, isNull: expanded === null, isEmpty: expanded === '', bodyLen: expanded?.length ?? 0, headSnippet: expanded?.slice(0, 120) ?? null });
					if (expanded) {
						explicitSkillBodies.push({ id: skillId, body: expanded });
						// Bump MRU so this skill ranks higher in autocomplete next time.
						this.skillsLibraryService.trackSkillUse?.(skillId);
					}
				} catch (err) {

					vibeLog.warn('Skill', 'expand threw', { skillId, err: String(err) });
				}
			}

			vibeLog.debug('Skill', 'final context built', { expansionsCount: explicitSkillBodies.length, totalBodyChars: explicitSkillBodies.reduce((a, b) => a + b.body.length, 0) });
		}
		// Build the user-message prefix once; we prepend it after `_chatMessagesToSimpleMessages`
		// converts to the canonical wire format.
		const explicitSkillsUserPrefix = explicitSkillBodies.length === 0 ? '' : (() => {
			const blocks = explicitSkillBodies
				.map(({ id, body }) => `<skill_invocation name="${id}">\n${body}\n</skill_invocation>`)
				.join('\n\n');
			const intro = explicitSkillBodies.length === 1
				? `The user invoked /skill:${explicitSkillBodies[0].id}. Follow the procedure in the skill body below as authoritative guidance for this request.`
				: `The user invoked ${explicitSkillBodies.length} skills. Follow the procedures in the skill bodies below as authoritative guidance for this request.`;
			// Closing contract: prevents "dump-style" replies where the model echoes the
			// skill body or referenced file contents verbatim back to the user (see
			// model-stalls.md #003 — nemotron-3-super-free verbatim-dumped process.md
			// and stalled mid-stream). Imitation-prone models (nemotron / minimax /
			// qwen variants) need this explicit boundary between "input directive" and
			// "expected output". Strict, short, and placed AFTER the skill body so it's
			// the last thing the model reads before the actual user request.
			const closing = 'Important: act on the procedure above silently. Do NOT echo the skill body or referenced file contents back to the user verbatim. Summarize only what is needed for the next step.';
			return `${intro}\n\n${blocks}\n\n${closing}`;
		})();

		const auditSkills = this.configurationService.getValue<boolean>('vibeide.skills.auditSkillSuggestions') ?? false;
		if (auditSkills && this.auditLogService.isEnabled()) {
			const explicitSkillIds = [...lastUserTextForSkills.matchAll(/\/skill:\s*([\w.-]+)/gi)].map(m => m[1]);
			const hasImplicitBlock = implicitSkills.trim().length > 0;
			if (hasImplicitBlock || explicitSkillIds.length > 0) {
				const implicitMatches = hasImplicitBlock
					? await this.skillsLibraryService.getImplicitSkillRankedMatches(lastUserTextForSkills, chatMode)
					: [];
				const sessionActive = this.configurationService.getValue<string[]>('vibeide.skills.sessionActiveIds') ?? [];
				void this.auditLogService.append({
					ts: Date.now(),
					action: 'skill_suggestion',
					ok: true,
					meta: {
						chatMode,
						explicitSkillIds,
						implicit: implicitMatches.map(m => ({ id: m.skillId, score: Number(m.score.toFixed(4)) })),
						sessionFilterActive: sessionActive.filter(Boolean).length > 0,
					},
				}).catch(() => { });
			}
		}
		const responseLangSetting = this.configurationService.getValue<string>('vibeide.agent.responseLanguage') ?? 'auto';
		// Synthetic nudges are always Russian — detecting language from them would override the user's.
		const lastUserForLang = [...chatMessages].reverse().find((m): m is ChatMessage & { role: 'user' } => m.role === 'user' && !m.isSyntheticNudge);
		const lastUserTextForLang = typeof lastUserForLang?.content === 'string' ? lastUserForLang.content : '';
		const langDirective = buildResponseLanguageDirective(responseLangSetting, lastUserTextForLang);
		// NOTE: explicitSkillBodies are NOT added to system prompt — they get prepended
		// to the last user message below. See model-stalls.md #002 for why.
		// R.2 — file context for glob-scoped rules ("Auto Attached"): open editors + active editor
		// + files the agent touched (read/edited) this thread, normalised to workspace-relative paths.
		const ruleWsFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath);
		const ruleOpenFiles = this.editorService.editors.map(e => e.resource?.fsPath).filter((p): p is string => !!p);
		const ruleActiveFile = this.editorService.activeEditor?.resource?.fsPath;
		const ruleContextFiles = [
			...ruleOpenFiles,
			...(ruleActiveFile ? [ruleActiveFile] : []),
			...extractToolFilePaths(chatMessages),
		].map(p => toWorkspaceRelative(p, ruleWsFolders)).filter(p => p.length > 0);
		// Prompt-caching: implicitSkills + langDirective derive from the LAST user message and
		// change every turn — they ride in the user turn (userTurnPrefix below), NOT in the
		// system-bound aiInstructions, so the system prefix stays byte-stable across turns.
		const aiInstructions = [this._getCombinedAIInstructions({ userText: lastUserTextForSkills, files: ruleContextFiles }), skillsDiscovery].filter(s => s.trim().length > 0).join('\n\n');
		const isReasoningEnabled = getIsReasoningEnabledState('Chat', validProviderName, modelName, modelSelectionOptions, overridesOfModel);
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(validProviderName, modelName, { isReasoningEnabled, overridesOfModel });
		let llmMessages = this._chatMessagesToSimpleMessages(chatMessages);

		// R.5 — `@rule:NAME` / `/rule:NAME` loads a specific (possibly conditional / agent-requested)
		// rule body ON DEMAND, prepended to the user turn alongside any /skill: bodies (same
		// mechanism, model-stalls #002: the body must live in the user's turn to bind to the request).
		const invokedRuleBlocks: string[] = [];
		for (const ruleName of parseRuleInvocations(lastUserTextForSkills)) {
			const body = this.projectRulesService.getRuleByName(ruleName)?.content.trim();
			if (body) {
				invokedRuleBlocks.push(`<rule_invocation name="${ruleName}">\n${body}\n</rule_invocation>`);
			} else if (!this._warnedUnknownRules.has(ruleName)) {
				// R.12 — surface a typo'd / missing @rule once per name (silent drop was confusing).
				this._warnedUnknownRules.add(ruleName);
				this.notificationService.notify({
					severity: Severity.Warning,
					message: localize('vibeide.rules.unknownInvocation', 'Правило @rule:{0} не найдено — проверьте имя (без расширения) или список в панели «Правила проекта».', ruleName),
				});
			}
		}
		const ruleInvocationPrefix = invokedRuleBlocks.length > 0
			? `The user invoked @rule. Follow the rule body below as authoritative for this request.\n\n${invokedRuleBlocks.join('\n\n')}`
			: '';

		// Prepend the per-turn dynamic blocks into the last user message's content. This is the
		// load-bearing step that makes /skill:NAME and @rule:NAME actually take effect, and the
		// cache-friendly home for everything that varies per turn (repo retrieval, implicit skill
		// hints, language directive) — see knowledge/roadmap/token-economy.md (A).
		const userTurnPrefix = [repoContextUserBlock, explicitSkillsUserPrefix, ruleInvocationPrefix, implicitSkills.trim(), langDirective.trim()].filter(s => s.length > 0).join('\n\n');
		if (userTurnPrefix.length > 0) {
			for (let i = llmMessages.length - 1; i >= 0; i--) {
				const m = llmMessages[i];
				// Bind skill/rule bodies to the last REAL user turn — prefixing a synthetic nudge
				// would associate the invocation with system boilerplate instead of the request.
				if (m.role === 'user' && !m.isSyntheticNudge) {
					const original = typeof m.content === 'string' ? m.content : '';
					(m as { content: string }).content = `${userTurnPrefix}\n\n${original}`;
					break;
				}
			}
		}

		// Smart context truncation: Prioritize recent messages and user selections
		const estimateTokens = (text: string) => Math.ceil(text.length / 4);
		const approximateTotalTokens = (msgs: { role: string; content: string }[], sys: string, instr: string) =>
			msgs.reduce((acc, m) => acc + estimateTokens(m.content), estimateTokens(sys) + estimateTokens(instr));
		const rot = reservedOutputTokenSpace ?? 0;

		// Optimize context for local models: cap at reasonable values to reduce latency
		// Local models are slower with large contexts, so we cap them more aggressively
		// Detect local providers: explicit local providers + localhost endpoints
		const isExplicitLocalProvider: boolean = validProviderName === 'ollama' || validProviderName === 'vLLM' || validProviderName === 'lmStudio';
		let isLocalhostEndpoint: boolean = false;
		if (validProviderName === 'openAICompatible' || validProviderName === 'liteLLM') {
			const endpoint = this.vibeideSettingsService.state.settingsOfProvider[validProviderName]?.endpoint || '';
			if (endpoint) {
				try {
					// Use proper URL parsing to check hostname (consistent with sendLLMMessage.impl.ts)
					const url = new URL(endpoint);
					const hostname = url.hostname.toLowerCase();
					isLocalhostEndpoint = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1';
				} catch (e) {
					// Invalid URL - assume non-local (safe default)
					isLocalhostEndpoint = false;
				}
			}
		}
		const isLocalProviderForContext: boolean = isExplicitLocalProvider || isLocalhostEndpoint;

		// For local models: apply feature-specific token caps and compress chat history
		// Instead of hard truncation, use semantic compression to preserve context
		if (isLocalProviderForContext) {
			// Note: Chat history compression is now handled by ChatHistoryCompressor
			// This keeps the last 5 turns uncompressed and compresses older messages
			// The compression happens in prepareLLMChatMessages before this point
			// For now, we keep a simple fallback limit if compression isn't available
			// plan mode: 3 turn pairs (same as normal — plan is short-lived before Execute)
			const maxTurnPairs = chatMode === 'agent' ? 5 : 3;
			// Synthetic nudges don't count as turns — they'd shrink the retained window.
			const userMessages = llmMessages.filter(m => m.role === 'user' && !m.isSyntheticNudge);
			if (userMessages.length > maxTurnPairs * 2) {
				// Keep only the last maxTurnPairs user messages and their corresponding assistant messages
				const beforeCount = llmMessages.length;
				const lastUserIndices = userMessages.slice(-maxTurnPairs).map(um => llmMessages.indexOf(um));
				const firstIndexToKeep = Math.min(...lastUserIndices);
				// Honor pinned (roadmap pin-context): keep pinned messages even if older than the
				// retained turn window, so important context isn't dropped before budget-fill runs.
				llmMessages = llmMessages.filter((m, i) => i >= firstIndexToKeep || m.pinned);
				// NO SILENT TRIMS: local-model fallback dropped older history pairs — log it.
				const dropped = beforeCount - llmMessages.length;
				if (dropped > 0) {
					vibeLog.warn('ContextGuard', `Local-model history fallback dropped ${dropped} older message(s), keeping last ${maxTurnPairs} turn-pair(s) + pinned (${chatMode} mode).`);
				}
			}
		}

		let effectiveContextWindow = contextWindow;
		if (isLocalProviderForContext) {
			// Apply feature-specific token cap for Chat feature
			const chatTokenCap = LOCAL_MODEL_TOKEN_CAPS['Chat'];
			effectiveContextWindow = Math.min(contextWindow, chatTokenCap + (reservedOutputTokenSpace || LOCAL_MODEL_RESERVED_OUTPUT));
		} else {
			// Cloud models: use the model's FULL advertised context window. The previous
			// 50%/16k caps were a latency hedge, but on agentic runs they starved the model
			// of context: a 128k model was budgeted at 64k, then the budget-fill truncation
			// below trimmed further, forcing premature history summarization. With every
			// prior tool result erased, the agent re-issued the same reads in circles
			// (observed deepseek-v4-pro re-read loop). The budget-fill + Step A.5 passes
			// below already keep the payload within the real window, so capping here only
			// discarded usable headroom. Trust the advertised window.
			effectiveContextWindow = contextWindow;
		}

		// More aggressive budget: use 75% instead of 80% to leave more room for output
		// For local models, use 70% to further reduce latency
		const budgetMultiplier = isLocalProviderForContext ? 0.70 : 0.75;
		const budget = Math.max(256, Math.floor(effectiveContextWindow * budgetMultiplier) - rot);
		const beforeTokens = approximateTotalTokens(llmMessages, systemMessage, aiInstructions);

		// Token-budget self-calibration (roadmap "provider-reported usage"). Our estimates are raw
		// `length/4`; the provider's real promptTokens include tool-schema JSON + formatting +
		// the model's true tokenizer. We keep estimating raw and instead DIVIDE the budget/cap
		// thresholds by the learned factor, so the reserved headroom tracks reality. Factor 1
		// (default / disabled / no sample yet) leaves behavior unchanged.
		const calibrationKey = `${validProviderName}:${modelName}`;
		const calibrationEnabled = this.configurationService.getValue<boolean>('vibeide.chat.calibrateTokenBudgetFromUsage') !== false;
		const calibrationMaxFactor = this.configurationService.getValue<number>('vibeide.context.tokenCalibrationMaxFactor') ?? TOKEN_CALIBRATION_MAX;
		const calibrationFactor = calibrationEnabled ? clampTokenCalibration(this._tokenCalibrationByModel.get(calibrationKey), calibrationMaxFactor) : 1;
		const calBudget = Math.max(256, Math.floor(budget / calibrationFactor));

		// Clear any stale budget-fill stats from a previous build; the truncation branch below
		// repopulates them when it fires. Keeps the UI transparency indicator accurate.
		try { this.contextGuardService.setTruncationStats(undefined, undefined); } catch { }

		// NOTE: ContextGuard status updates intentionally moved to AFTER both
		// truncation passes. Previously we called updateUsage(beforeTokens, …)
		// here, which surfaced "100%+ full" warnings reflecting the RAW state
		// size — but the payload we actually send to the provider is already
		// truncated below to fit. That made the guard spam Critical warnings
		// while the request was perfectly fine, and added a hot callback per
		// stream chunk on long sessions. The intermediate updateUsage on the
		// truncation branch (after the smart-truncation if-block) and the
		// final updateUsage (after Step B, line ~2005) are the source of
		// truth — both reflect post-truncation reality.

		if (beforeTokens > calBudget && llmMessages.length > 6) {
			// Budget-FILL truncation: keep as MANY of the newest messages as fit within
			// `budget` at full fidelity, and summarize ONLY the genuine overflow head.
			//
			// The previous implementation kept a FIXED tail of 6 messages and crushed
			// everything older into a ~2.4KB <chat_summary> stub — regardless of how much
			// budget remained. A 150k-token agentic history therefore collapsed to ~9k even
			// with a 48k budget, erasing every prior tool result. The model lost all memory
			// of files it had already read and re-issued identical reads in circles (the
			// observed deepseek-v4-pro loop). Filling the budget preserves recent reads/edits,
			// so the model sees what it already did and stops repeating itself.
			// Char budgets for the <chat_summary> block. Single source of truth: the reserve
			// subtracted from tailBudget is DERIVED from these, so the reserve always matches
			// what the summary can actually produce (the old fixed 1200-token reserve under-
			// counted the ~2.1k-token worst case — pinned task 6000c + body 2400c — letting
			// afterTokens drift over the soft budget; the hard-cap pass caught it, but the
			// accounting was inconsistent).
			const PINNED_TASK_MAX_CHARS = 6000;
			const PER_USER_MSG_MAX_CHARS = 2000;
			const USER_SUMMARY_MAX_CHARS = 2500;
			const PER_OTHER_MSG_MAX_CHARS = 500;
			const OTHER_SUMMARY_MAX_CHARS = 800;
			const SUMMARY_BODY_MAX_CHARS = 2400;
			const SUMMARY_WRAPPER_CHARS = 96; // tags + heading boilerplate
			const sysInstrTokens = estimateTokens(systemMessage) + estimateTokens(aiInstructions);
			// Reserve room for the summary block we may prepend to the system message, sized to its
			// worst-case char output (pinned original task + summary body). Mirrors estimateTokens'
			// chars-per-token ratio without allocating the placeholder string.
			const summaryReserve = Math.ceil((PINNED_TASK_MAX_CHARS + SUMMARY_BODY_MAX_CHARS + SUMMARY_WRAPPER_CHARS) / 4);
			const tailBudget = Math.max(256, calBudget - sysInstrTokens - summaryReserve);

			// Plan the kept set: the recent budget-fit tail PLUS any PINNED message that falls in
			// the older head (kept verbatim so important context survives truncation regardless of
			// age — roadmap pin-context). Only the older, non-pinned head is summarized.
			// (Pure selection in agentLoopHeuristics.planBudgetFillTail.)
			const plan = planBudgetFillTail(
				llmMessages.map(m => ({ tokens: estimateTokens(m.content), pinned: m.pinned })),
				tailBudget
			);
			const head = plan.summarizeIndices.map(i => llmMessages[i]);
			const keep = plan.keepIndices.map(i => llmMessages[i]);

			if (head.length > 0) {
				const firstUser = llmMessages.find(m => m.role === 'user');
				// The original task is worth pinning into the summary ONLY if it actually landed in
				// the summarized head; a pinned first message stays verbatim in `keep` (no double-pin).
				const originalDropped = !!firstUser && head.includes(firstUser);
				const pinnedOriginal = originalDropped
					? `<original_user_task>\n${firstUser.content.slice(0, PINNED_TASK_MAX_CHARS)}${firstUser.content.length > PINNED_TASK_MAX_CHARS ? '\n…' : ''}\n</original_user_task>\n\n`
					: '';

				// Prioritize user messages (they carry selections/intent); summarize the rest.
				const userMessages = head.filter(m => m.role === 'user');
				const otherMessages = head.filter(m => m.role !== 'user');
				const userSummary = userMessages.map(m => `${m.role}: ${m.content.slice(0, PER_USER_MSG_MAX_CHARS)}`).join('\n').slice(0, USER_SUMMARY_MAX_CHARS);
				const otherSummary = otherMessages.map(m => `${m.role}: ${m.content.slice(0, PER_OTHER_MSG_MAX_CHARS)}`).join('\n').slice(0, OTHER_SUMMARY_MAX_CHARS);

				const headConcat = userSummary + (otherSummary ? '\n' + otherSummary : '');
				const summaryBody = `${pinnedOriginal}Prior conversation summarized (${head.length} older messages; ${keep.length} kept in full incl. pinned). Key points:\n${headConcat.slice(0, SUMMARY_BODY_MAX_CHARS)}${headConcat.length > SUMMARY_BODY_MAX_CHARS ? '…' : ''}`;
				const summary = `\n\n<chat_summary>\n${summaryBody}\n</chat_summary>`;
				systemMessage = (systemMessage || '') + summary;
				llmMessages = keep;
				// Surface budget-fill transparency to the UI: N kept full / M summarized.
				try { this.contextGuardService.setTruncationStats(keep.length, head.length); } catch { }
			}
			const afterTokens = approximateTotalTokens(llmMessages, systemMessage, aiInstructions);
			// Update status bar to reflect post-truncation size; suppress popup (user sees % in status bar)
			try { this.contextGuardService.updateUsage(Math.round(afterTokens * calibrationFactor), contextWindow); } catch { }
			vibeLog.debug('convertToLLMMessage', `Context smart truncation (budget-fill): ~${beforeTokens} → ~${afterTokens} tokens (kept ${llmMessages.length} msgs full, ${head.length} summarized)`); recordChatTrace('context:truncated', { before: beforeTokens, after: afterTokens });
		}

		// Second pass — active guard. If we are still over the model's real context window,
		// aggressively elide oversized tool/assistant outputs and drop oldest tail messages
		// before the request is sent. This prevents the empty-response failure mode that
		// happens when the model refuses or truncates oversized prompts.
		// hardCap and the final overflow window are in REAL tokens; our currentTokens is a raw
		// length/4 estimate. Divide by the calibration factor so the comparison happens in the
		// same (estimate) space — an under-counting estimator therefore trips the guard sooner.
		const hardCap = Math.floor((contextWindow * 0.92) / calibrationFactor); // 8% headroom for output/reasoning
		const TOOL_RESULT_TOKEN_THRESHOLD = 5000;
		let currentTokens = approximateTotalTokens(llmMessages, systemMessage, aiInstructions);

		// Step A.5 (proactive, token-budget) — one-shot compaction of old tool-results.
		// REDESIGNED 2026-06-07 (cache-friendly). The old trigger («older than the last N
		// user turns») was broken both ways: with a single real user message per agent run
		// it NEVER fired (history grew to 100k+ input-tokens/turn, 2M session burned in
		// minutes), and when it did fire (via the nudge-counting bug) the window slid EVERY
		// turn, rewriting the prefix and busting the prompt cache on each request. New contract:
		//   - trigger: total tool-result tokens exceed `compactToolResultsAtTokens` (0 = off);
		//   - action: ONE pass stubs every tool-result except the newest
		//     `compactKeepRecentToolResults` (pinned/small ones always survive);
		//   - between compactions history is append-only → the provider prefix cache lives;
		//     each compaction is ONE deliberate cache-bust, logged loudly (no silent trims).
		// Stubs are deterministic, so already-stubbed messages never change — later compactions
		// only add NEW stubs further down the list, keeping the earlier prefix cacheable.
		const compactAtTokens = Math.max(0, Math.min(500_000,
			this.configurationService.getValue<number>('vibeide.chat.compactToolResultsAtTokens') ?? 60_000
		));
		const keepRecentToolResults = Math.max(1, Math.min(100,
			this.configurationService.getValue<number>('vibeide.chat.compactKeepRecentToolResults') ?? 8
		));
		if (compactAtTokens > 0) {
			const toolIdxs: number[] = [];
			let toolResultTokens = 0;
			for (let i = 0; i < llmMessages.length; i++) {
				const m = llmMessages[i];
				if (m.role === 'tool') {
					toolIdxs.push(i);
					toolResultTokens += estimateTokens(m.content);
				}
			}
			if (toolResultTokens > compactAtTokens && toolIdxs.length > keepRecentToolResults) {
				// First index that must stay full — everything before it is compaction territory.
				const stubBefore = toolIdxs[toolIdxs.length - keepRecentToolResults];
				let compacted = 0;
				let savedTokens = 0;
				llmMessages = llmMessages.map((m, i) => {
					if (i < stubBefore && m.role === 'tool' && m.content.length > 300 && !m.pinned && !m.content.startsWith('[summarized:')) {
						const tokensBefore = estimateTokens(m.content);
						compacted++;
						savedTokens += tokensBefore;
						return { ...m, content: `[summarized: ${tokensBefore.toLocaleString()} tokens of older tool output. Re-call the tool if this result is needed again.]` };
					}
					return m;
				});
				if (compacted > 0) {
					currentTokens = approximateTotalTokens(llmMessages, systemMessage, aiInstructions);
					vibeLog.warn('ContextGuard', `Step A.5 compacted ${compacted} old tool-results: ~${savedTokens.toLocaleString()} tokens saved (trigger ${compactAtTokens.toLocaleString()}, kept last ${keepRecentToolResults}) → currentTokens ~${currentTokens.toLocaleString()}. Prompt-cache prefix rebuilds next turn.`);
				}
			}
		}

		if (currentTokens > hardCap) {
			// Step A — elide oversized tool / assistant outputs in remaining tail
			let elided = 0;
			let elidedTokens = 0;
			llmMessages = llmMessages.map(m => {
				const tokens = estimateTokens(m.content);
				if ((m.role === 'tool' || m.role === 'assistant') && tokens > TOOL_RESULT_TOKEN_THRESHOLD && !m.pinned) {
					elided++;
					elidedTokens += tokens;
					return { ...m, content: `[elided ${m.role} output: ~${tokens.toLocaleString()} tokens]` };
				}
				return m;
			});
			currentTokens = approximateTotalTokens(llmMessages, systemMessage, aiInstructions);
			// NO SILENT TRIMS: align Step A with Step A.5/Step B (both log). The in-band
			// `[elided …]` marker is visible to the model but not to operators reading the log.
			if (elided > 0) {
				vibeLog.warn('ContextGuard', `Step A elided ${elided} oversized tool/assistant output(s) > ${TOOL_RESULT_TOKEN_THRESHOLD} tokens (~${elidedTokens.toLocaleString()} tokens) to fit hardCap → currentTokens ~${currentTokens.toLocaleString()}.`);
			}
		}

		if (currentTokens > hardCap && llmMessages.length > 2) {
			// Step B — iteratively drop the OLDEST tail messages, but always keep the
			// last user message and the last assistant message so the current turn flow
			// stays coherent. Hard floor of 2 messages to avoid pathological prompts.
			const beforeStepB = currentTokens;
			let dropped = 0;
			while (currentTokens > hardCap && llmMessages.length > 2) {
				llmMessages = llmMessages.slice(1);
				dropped++;
				currentTokens = approximateTotalTokens(llmMessages, systemMessage, aiInstructions);
			}
			if (dropped > 0) {
				vibeLog.debug('ContextGuard', `Step B dropped ${dropped} oldest tail messages: ~${beforeStepB} → ~${currentTokens} tokens`);
			}
		}

		// Reflect the final number on the status bar.
		try { this.contextGuardService.setCalibrationFactor(calibrationEnabled ? calibrationFactor : undefined); } catch { }
		try { this.contextGuardService.updateUsage(Math.round(currentTokens * calibrationFactor), contextWindow); } catch { }

		// Pair this turn's RAW estimate of the sent payload with the provider's reported
		// promptTokens (arrives later via recordActualPromptTokens) to self-calibrate the budget.
		this._lastRawPromptEstimateByModel.set(calibrationKey, currentTokens);

		if (currentTokens > Math.floor(contextWindow / calibrationFactor)) {
			throw new ContextOverflowError({
				provider: validProviderName,
				model: modelName,
				finalTokens: currentTokens,
				contextWindow,
			});
		}

		const { messages, separateSystemMessage } = prepareMessages({
			messages: llmMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: validProviderName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			maxInputTokensSafety: this.configurationService.getValue<number>('vibeide.chat.maxInputTokensSafety') ?? 0,
			providerName: validProviderName,
		});

		// Diagnostic dump of the final prompt that will be sent to the provider.
		// Confirms whether the explicit-skill body actually survives the pipeline
		// (workspace_guidelines section, smart truncation, safetyTrim). Look for
		// `skillBodyPresent: true` AND a non-zero skillBodyHeadIdx in the section
		// where you expect it. Logs once per request via console.warn so it shows
		// up in DevTools alongside the [VibeIDE/Skill] expand traces.
		try {
			// LLMChatMessage is a discriminated union; user/assistant `content` can be either
			// a plain string OR an array of parts (text/image_url for OpenAI multimodal,
			// tool_use/tool_result for Anthropic). For models WHERE supportsSystemMessage===false,
			// the system prompt gets folded into the first user message's content as
			// `<SYSTEM_MESSAGE>...</SYSTEM_MESSAGE>` prefix — i.e. it ends up inside a
			// text-part of an array. Extracting a flat string requires walking that array.
			const extractText = (content: unknown): string => {
				if (typeof content === 'string') { return content; }
				if (Array.isArray(content)) {
					let out = '';
					for (const p of content as Array<{ type?: string; text?: unknown }>) {
						if (p && p.type === 'text' && typeof p.text === 'string') { out += p.text; }
					}
					return out;
				}
				return '';
			};
			const lenOf = (m: LLMChatMessage): number => {
				const anyM = m as { content?: unknown; parts?: unknown };
				if (typeof anyM.content === 'string') { return anyM.content.length; }
				if (Array.isArray(anyM.content)) {
					// Count tool blocks too — text-only counting showed every tool turn as len:0,
					// which left history-rewrite diagnostics blind (the deterministic prompt-cache
					// bust at iter ~11 could not be localized: tool_result sizes were invisible).
					let total = extractText(anyM.content).length;
					for (const p of anyM.content as Array<{ type?: string; content?: unknown; input?: unknown; name?: unknown }>) {
						if (p?.type === 'tool_result') { total += typeof p.content === 'string' ? p.content.length : 0; }
						else if (p?.type === 'tool_use') { total += (typeof p.name === 'string' ? p.name.length : 0) + JSON.stringify(p.input ?? {}).length; }
					}
					return total;
				}
				if (Array.isArray(anyM.parts)) {
					// Gemini parts shape: { text } or { functionCall }
					let out = 0;
					for (const p of anyM.parts as Array<{ text?: unknown }>) {
						if (p && typeof p.text === 'string') { out += p.text.length; }
					}
					return out;
				}
				return -1;
			};
			// Locate where the system prompt actually lives. Three cases:
			//   1) Separate system message — provider supports `system` field (Anthropic style).
			//   2) First message has role 'system' — supportsSystemMessage='system-role'|'developer-role'.
			//   3) Folded into first user message via <SYSTEM_MESSAGE> prefix — supportsSystemMessage===false.
			let sysContent = '';
			let sysLocation: 'separate' | 'role-system' | 'folded-into-user' | 'unknown' = 'unknown';
			if (typeof separateSystemMessage === 'string' && separateSystemMessage.length > 0) {
				sysContent = separateSystemMessage;
				sysLocation = 'separate';
			} else if (messages[0]) {
				const firstText = extractText((messages[0] as { content?: unknown }).content);
				if (messages[0].role === 'system') {
					sysContent = firstText;
					sysLocation = 'role-system';
				} else if (messages[0].role === 'user' && firstText.includes('<SYSTEM_MESSAGE>')) {
					sysContent = firstText;
					sysLocation = 'folded-into-user';
				}
			}
			const wgTagNeedle = '<workspace_guidelines';
			const skillInvocationTag = '<skill_invocation';
			const sysHasWGTag = sysContent.includes(wgTagNeedle);
			// Find the last user-role message text (walking array if needed) and check
			// for skill_invocation marker — this is where /skill:NAME body now lives
			// after the model-stalls #002 fix.
			let lastUserContent = '';
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === 'user') {
					lastUserContent = extractText((messages[i] as { content?: unknown }).content);
					break;
				}
			}
			const lastUserHasSkillInvocation = lastUserContent.includes(skillInvocationTag);
			const skillBodyHeadIdx = lastUserContent.indexOf(skillInvocationTag);
			vibeLog.debug('promptDump', 'final prompt summary', {
				provider: validProviderName,
				model: modelName,
				supportsSystemMessage,
				sysLocation,
				systemLen: sysContent.length,
				systemSnippetHead: sysContent.slice(0, 180),
				wgTagPresent: sysHasWGTag,
				lastUserMsgLen: lastUserContent.length,
				lastUserHasSkillInvocation,
				skillBodyHeadIdx,
				skillBodyHeadSnippet: skillBodyHeadIdx >= 0 ? lastUserContent.slice(skillBodyHeadIdx, skillBodyHeadIdx + 220) : null,
				explicitSkillsBodiesCount: explicitSkillBodies.length,
				explicitSkillsTotalBodyChars: explicitSkillBodies.reduce((a, b) => a + b.body.length, 0),
				aiInstructionsLen: aiInstructions.length,
				messagesCount: messages.length,
				messagesLens: messages.map(m => {
					const mm = m as { reasoning_content?: unknown; reasoning?: unknown; name?: unknown };
					const reasoning = typeof mm.reasoning_content === 'string' ? mm.reasoning_content : (typeof mm.reasoning === 'string' ? mm.reasoning : '');
					return {
						role: m.role,
						len: lenOf(m),
						reasoningLen: reasoning.length, // key signal for interleaved-reasoning stalls (minimax/deepseek/kimi): is reasoning carried on each assistant turn?
						...(m.role === 'tool' && typeof mm.name === 'string' ? { tool: mm.name } : {}),
					};
				}),
			});
			// Opt-in FULL payload (per-message content + reasoning), gated by
			// `vibeide.debug.dumpFullPrompt` to avoid bloating every request. Secrets are
			// redacted by the vibeLog redactor. This is THE capture point for diagnosing
			// reasoning-roundtrip stalls (minimax/openCodeGo) — no separate proxy needed.
			if (this.configurationService.getValue<boolean>('vibeide.debug.dumpFullPrompt')) {
				vibeLog.debug('promptDump', 'full prompt (vibeide.debug.dumpFullPrompt)', {
					system: sysContent,
					messages: messages.map(m => {
						const mm = m as { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; name?: unknown };
						const reasoning = typeof mm.reasoning_content === 'string' ? mm.reasoning_content : (typeof mm.reasoning === 'string' ? mm.reasoning : '');
						// Tool blocks were invisible here (extractText is text-parts-only), which
						// blinded the history-rewrite investigation — dump heads of each block too.
						const blocks = Array.isArray(mm.content)
							? (mm.content as Array<{ type?: string; content?: unknown; input?: unknown; name?: unknown; text?: unknown }>).map(p => ({
								type: p?.type,
								head: p?.type === 'tool_result' && typeof p.content === 'string' ? `${(p.content as string).length}c: ${(p.content as string).slice(0, 160)}`
									: p?.type === 'tool_use' ? `${String(p.name)} ${JSON.stringify(p.input ?? {}).slice(0, 140)}`
										: p?.type === 'text' && typeof p.text === 'string' ? `${p.text.length}c: ${p.text.slice(0, 160)}`
											: undefined,
							}))
							: undefined;
						return {
							role: m.role,
							tool: m.role === 'tool' && typeof mm.name === 'string' ? mm.name : undefined,
							reasoning: reasoning || undefined,
							content: extractText(mm.content),
							...(blocks ? { blocks } : {}),
						};
					}),
				});
			}
		} catch (e) {

			vibeLog.warn('promptDump', 'dump failed', { err: String(e) });
		}

		return { messages, separateSystemMessage };
	};


	// --- FIM ---

	prepareFIMMessage: IConvertToLLMMessageService['prepareFIMMessage'] = ({ messages, modelSelection, featureName, languageId }) => {
		const { settingsOfProvider } = this.vibeideSettingsService.state;

		// Detect if local provider for optimizations
		const isLocal = modelSelection && modelSelection.providerName !== 'auto' ? isLocalProvider(modelSelection.providerName, settingsOfProvider) : false;

		// For local models, skip verbose AI instructions to reduce tokens
		const combinedInstructions = (isLocal && featureName === 'Autocomplete')
			? '' // Skip verbose AI instructions for local autocomplete
			: this._getCombinedAIInstructions();

		// Add language context to help model generate correct language code
		// This is the PROPER fix - tell the model what language it's completing
		// Make it explicit and strong to prevent wrong language or explanatory comments
		const languageContext = languageId && featureName === 'Autocomplete'
			? `// Language: ${languageId}\n// Generate ${languageId} code only. Do not add comments or explanations.\n`
			: '';

		let prefix = `\
${languageContext}\
${!combinedInstructions ? '' : `\
// Instructions:
// Do not output an explanation. Do not output comments. Only output the middle code.
${combinedInstructions.split('\n').map(line => `//${line}`).join('\n')}`}

${messages.prefix}`;

		let suffix = messages.suffix;
		const stopTokens = messages.stopTokens;

		// Apply local token caps and smart truncation for local models
		if (isLocal && featureName === 'Autocomplete') {
			const autocompleteTokenCap = LOCAL_MODEL_TOKEN_CAPS['Autocomplete']; // 1,000 tokens
			const maxChars = autocompleteTokenCap * CHARS_PER_TOKEN; // ~4,000 chars

			// Smart truncation: prioritize code near cursor, cut at line boundaries
			const truncatePrefixSuffix = (text: string, maxChars: number, isPrefix: boolean): string => {
				if (text.length <= maxChars) { return text; }

				// Split into lines for line-boundary truncation
				const lines = text.split('\n');
				let totalChars = 0;
				const resultLines: string[] = [];

				// For prefix: keep lines from the end (closest to cursor)
				// For suffix: keep lines from the start (closest to cursor)
				if (isPrefix) {
					// Prefix: keep last lines (closest to cursor)
					for (let i = lines.length - 1; i >= 0; i--) {
						const line = lines[i];
						const lineWithNewline = line + '\n';
						if (totalChars + lineWithNewline.length > maxChars) { break; }
						resultLines.unshift(line);
						totalChars += lineWithNewline.length;
					}
					return resultLines.join('\n');
				} else {
					// Suffix: keep first lines (closest to cursor)
					for (let i = 0; i < lines.length; i++) {
						const line = lines[i];
						const lineWithNewline = (i < lines.length - 1 ? line + '\n' : line);
						if (totalChars + lineWithNewline.length > maxChars) { break; }
						resultLines.push(line);
						totalChars += lineWithNewline.length;
					}
					return resultLines.join('\n');
				}
			};

			// Apply truncation to combined prefix+suffix, prioritizing code near cursor
			const combinedLength = prefix.length + suffix.length;
			if (combinedLength > maxChars) {
				// Allocate space proportionally, but favor suffix (code after cursor) slightly
				const prefixMaxChars = Math.floor(maxChars * 0.45); // 45% for prefix
				const suffixMaxChars = Math.floor(maxChars * 0.55); // 55% for suffix

				prefix = truncatePrefixSuffix(prefix, prefixMaxChars, true);
				suffix = truncatePrefixSuffix(suffix, suffixMaxChars, false);
			}
		}

		return { prefix, suffix, stopTokens };
	};


}


registerSingleton(IConvertToLLMMessageService, ConvertToLLMMessageService, InstantiationType.Eager);








/*
Gemini has this, but they're openai-compat so we don't need to implement this
gemini request:
{   "role": "assistant",
	"content": null,
	"function_call": {
		"name": "get_weather",
		"arguments": {
			"latitude": 48.8566,
			"longitude": 2.3522
		}
	}
}

gemini response:
{   "role": "assistant",
	"function_response": {
		"name": "get_weather",
			"response": {
			"temperature": "15°C",
				"condition": "Cloudy"
		}
	}
}
*/



