/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ImageType, QuestionType, imageQARegistry } from './modelRegistry.js';

export interface RoutingDecision {
	imageType: ImageType;
	questionType: QuestionType;
	path: 'ocr_code' | 'vlm_only' | 'ocr_vlm_hybrid';
	confidence: number;
	reasoning: string;
}

/**
 * Image & Question Router
 * Detects image_type and question_type to route to appropriate processing path
 */
export class ImageQARouter {
	/**
	 * Detect image type from image data and user question
	 * @param preferOnline - Prefer online models for image/code tasks
	 */
	async route(
		imageData: Uint8Array,
		imageWidth: number,
		imageHeight: number,
		userQuestion: string,
		preferOnline: boolean = true
	): Promise<RoutingDecision> {
		const questionType = this.detectQuestionType(userQuestion);
		const imageType = await this.detectImageType(imageData, imageWidth, imageHeight, userQuestion);

		// Check model availability in registry
		const totalPixels = imageWidth * imageHeight;
		const hasCodeModel = imageQARegistry.findBestForTask('code', imageType, questionType, totalPixels, preferOnline);
		const hasVLMModel = imageQARegistry.findBestForTask('vlm', imageType, questionType, totalPixels, preferOnline);
		const hasOCRModel = imageQARegistry.findBestForTask('ocr', imageType, questionType, totalPixels, false);

		// Determine processing path based on image type, question type, and model availability
		let path: RoutingDecision['path'];
		let confidence = 0.7;
		let reasoning = '';

		if (imageType === 'terminal/log' || imageType === 'code_screenshot') {
			// Code/terminal images: prefer OCR+Code path
			if (hasOCRModel && hasCodeModel) {
				path = 'ocr_code';
				confidence = 0.9;
				reasoning = `${imageType} detected - using OCR → Code LLM path (${preferOnline ? 'online' : 'local'} models preferred)`;
			} else if (hasOCRModel) {
				path = 'ocr_code';
				confidence = 0.7;
				reasoning = `${imageType} detected - using OCR path (code model not available)`;
			} else {
				path = 'ocr_code'; // Fallback - OCR should always be available
				confidence = 0.5;
				reasoning = `OCR+Code path selected but model availability unclear`;
			}
		} else if (imageType === 'chart/diagram' || imageType === 'photo') {
			// Visual content: prefer VLM
			if (hasVLMModel) {
				path = 'vlm_only';
				confidence = 0.8;
				reasoning = `${imageType} detected - using VLM for visual analysis (${preferOnline ? 'online' : 'local'} preferred)`;
			} else if (hasOCRModel) {
				path = 'ocr_code';
				confidence = 0.6;
				reasoning = `${imageType} detected - VLM not available, falling back to OCR`;
			} else {
				path = 'vlm_only';
				confidence = 0.5;
				reasoning = `VLM path selected but model availability unclear`;
			}
		} else if (imageType === 'document/receipt') {
			if (questionType === 'extract_text') {
				path = hasOCRModel ? 'ocr_code' : 'ocr_vlm_hybrid';
				confidence = 0.85;
				reasoning = `Document detected - OCR primary path (${preferOnline ? 'online' : 'local'} preferred)`;
			} else {
				if (hasVLMModel && hasOCRModel) {
					path = 'ocr_vlm_hybrid';
					confidence = 0.85;
					reasoning = `Document detected - hybrid approach (${preferOnline ? 'online' : 'local'} preferred)`;
				} else if (hasOCRModel) {
					path = 'ocr_code';
					confidence = 0.7;
					reasoning = `Document detected - OCR only (VLM not available)`;
				} else {
					path = 'ocr_vlm_hybrid';
					confidence = 0.6;
					reasoning = `Document detected - hybrid path selected`;
				}
			}
		} else if (imageType === 'UI/app') {
			if (hasVLMModel && hasOCRModel) {
				path = 'ocr_vlm_hybrid';
				confidence = 0.8;
				reasoning = `UI screenshot - hybrid approach (${preferOnline ? 'online' : 'local'} preferred)`;
			} else if (hasOCRModel) {
				path = 'ocr_code';
				confidence = 0.7;
				reasoning = 'UI screenshot - OCR only (VLM not available)';
			} else {
				path = 'ocr_vlm_hybrid';
				confidence = 0.6;
				reasoning = 'UI screenshot - hybrid path selected';
			}
		} else {
			// Default to OCR+code for text-heavy content
			path = hasOCRModel && hasCodeModel ? 'ocr_code' : 'ocr_code';
			confidence = 0.6;
			reasoning = `Unknown type - defaulting to OCR+Code LLM path (${preferOnline ? 'online' : 'local'} preferred)`;
		}

		return {
			imageType,
			questionType,
			path,
			confidence,
			reasoning,
		};
	}

	/**
	 * Detect image type using heuristics
	 */
	private async detectImageType(
		imageData: Uint8Array,
		width: number,
		height: number,
		userQuestion: string
	): Promise<ImageType> {
		// Quick heuristics based on dimensions, aspect ratio, and question content
		const aspectRatio = width / height;
		const totalPixels = width * height;

		// Terminal/log detection: usually wide, dark backgrounds
		const questionLower = userQuestion.toLowerCase();
		if (
			questionLower.includes('error') ||
			questionLower.includes('terminal') ||
			questionLower.includes('log') ||
			questionLower.includes('exception') ||
			questionLower.includes('stack trace')
		) {
			return 'terminal/log';
		}

		// Code screenshot: often wide, contains code keywords
		if (
			questionLower.includes('code') ||
			questionLower.includes('function') ||
			questionLower.includes('snippet') ||
			questionLower.includes('implementation')
		) {
			return 'code_screenshot';
		}

		// Chart/diagram: often square-ish or wide
		if (
			questionLower.includes('chart') ||
			questionLower.includes('diagram') ||
			questionLower.includes('graph') ||
			questionLower.includes('visualization')
		) {
			return 'chart/diagram';
		}

		// UI/app: wide aspect ratio, UI-related keywords
		if (
			questionLower.includes('ui') ||
			questionLower.includes('interface') ||
			questionLower.includes('button') ||
			questionLower.includes('component') ||
			questionLower.includes('app')
		) {
			return 'UI/app';
		}

		// Document/receipt: portrait, text-heavy
		if (aspectRatio < 0.8 && (questionLower.includes('document') || questionLower.includes('receipt'))) {
			return 'document/receipt';
		}

		// Photo: high pixel count, not obviously code
		if (totalPixels > 2_000_000 && !questionLower.includes('code') && !questionLower.includes('error')) {
			return 'photo';
		}

		// Default
		return 'unknown';
	}

	/**
	 * Detect question type from user query
	 */
	private detectQuestionType(question: string): QuestionType {
		const q = question.toLowerCase();

		if (q.includes('extract') || q.includes('what text') || q.includes('what does it say')) {
			return 'extract_text';
		}
		if (q.includes('error') || q.includes('why') || q.includes('wrong') || q.includes('failing')) {
			return 'explain_error';
		}
		if (q.includes('summarize') || q.includes('summary') || q.includes('what happened')) {
			return 'summarize_logs';
		}
		if (q.includes('find') || q.includes('where is') || q.includes('locate')) {
			return 'find_UI_element';
		}
		if (q.includes('compare') || q.includes('difference') || q.includes('vs')) {
			return 'compare';
		}
		if (q.length < 20) {
			return "what's_shown"; // Short questions often just asking what's shown
		}

		return 'unknown';
	}

	/**
	 * Log routing decision (dev mode)
	 */
	logDecision(decision: RoutingDecision, devMode: boolean = false): void {
		if (devMode) {
			console.log('[ImageQA Router]', {
				imageType: decision.imageType,
				questionType: decision.questionType,
				path: decision.path,
				confidence: decision.confidence.toFixed(2),
				reasoning: decision.reasoning,
			});
		}
	}
}

// Singleton instance
export const imageQARouter = new ImageQARouter();

