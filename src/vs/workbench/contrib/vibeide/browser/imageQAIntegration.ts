/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Integration service for Image QA Pipeline
 * Hooks into chat flow to process images locally before sending to LLM
 */

import { ChatImageAttachment } from '../common/chatThreadServiceTypes.js';
import { imageQAPipeline, type ImageQAOptions, type QAResponse } from '../common/imageQA/index.js';
import { ModelSelection } from '../common/vibeideSettingsTypes.js';

export interface ImageQAPreprocessedMessage {
	shouldUsePipeline: boolean;
	processedText?: string; // Text to send to LLM (may include OCR results)
	qaResponse?: QAResponse; // Direct answer if pipeline fully handled it
	images?: ChatImageAttachment[]; // Original images if still needed
}

/**
 * Check if we should use the Image QA pipeline for this message
 */
export function shouldUseImageQAPipeline(images: ChatImageAttachment[] | undefined): boolean {
	if (!images || images.length === 0) return false;

	// Use pipeline for text-heavy images (terminal, code, documents)
	// For now, use for all images (can be refined with heuristics)
	return true;
}

/**
 * Preprocess images through the QA pipeline
 * Returns processed text that can be sent to the code model
 */
export async function preprocessImagesForQA(
	images: ChatImageAttachment[],
	userQuestion: string,
	modelSelection: ModelSelection | null,
	devMode: boolean = false,
	settings?: {
		allowRemoteModels?: boolean;
		enableHybridMode?: boolean;
	}
): Promise<ImageQAPreprocessedMessage> {
	if (!shouldUseImageQAPipeline(images)) {
		return { shouldUsePipeline: false, images };
	}

	// For now, process the first image
	// In production, could process multiple or ask user to select
	const image = images[0];

	try {
		const allowRemoteModels = settings?.allowRemoteModels ?? false;
		const preferOnline = true; // Image and code tasks favor online models

		const options: ImageQAOptions = {
			imageData: image.data,
			mimeType: image.mimeType,
			width: image.width,
			height: image.height,
			userQuestion,
			codeModel: modelSelection ? {
				provider: modelSelection.providerName,
				model: modelSelection.modelName,
			} : undefined,
			devMode,
			allowRemoteModels,
			preferOnline,
		};

		const qaResponse = await imageQAPipeline.process(options);

		// Handle responses that need LLM processing
		if ((qaResponse as any)._needsLLM || (qaResponse as any)._needsVLM) {
			return {
				shouldUsePipeline: true,
				processedText: (qaResponse as any)._prompt || userQuestion,
				qaResponse,
				images: images, // Keep images for VLM/LLM processing
			};
		}

		// If confidence is high enough, use the pipeline answer directly
		if (qaResponse.confidence > 0.7 && !qaResponse.needsUserInput && qaResponse.answer) {
			return {
				shouldUsePipeline: true,
				qaResponse,
				processedText: qaResponse.answer,
			};
		}

		// Otherwise, include OCR results in the message for the LLM to reason about
		return {
			shouldUsePipeline: true,
			processedText: qaResponse.answer ? `[Image QA Pipeline] ${qaResponse.answer}\n\nIf you need more detail, please provide additional context.` : userQuestion,
			qaResponse,
			images: images, // Keep images for VLM if needed
		};

	} catch (error: any) {
		console.error('[ImageQA] Pipeline error:', error);

		// Fallback: send images normally
		return {
			shouldUsePipeline: false,
			images,
		};
	}
}

