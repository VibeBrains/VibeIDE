/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ImageType, QuestionType } from './modelRegistry.js';
import { imageQARouter, RoutingDecision } from './imageRouter.js';
import { getOCRService, OCRResult } from './ocrService.js';
import { checkRemoteModelCall, logImageProcessingDecision } from './securityGuardrails.js';

export interface QAResponse {
	answer: string;
	confidence: number;
	unknowns: string[];
	citedBlocks?: number[]; // Block indices referenced in answer
	needsUserInput?: {
		message: string;
		suggestedRegions?: Array<{ bbox: { x: number; y: number; width: number; height: number }; label: string }>;
	};
	// Internal flags for pipeline processing
	_needsLLM?: boolean;
	_prompt?: string;
}

export interface ImageQAOptions {
	imageData: Uint8Array;
	mimeType: string;
	width: number;
	height: number;
	userQuestion: string;
	codeModel?: { provider: string; model: string }; // Selected code model
	vlmModel?: { provider: string; model: string }; // Selected VLM model
	devMode?: boolean;
	allowRemoteModels?: boolean; // Whether remote models are allowed
	preferOnline?: boolean; // Prefer online models for image/code tasks
}

/**
 * Main Image QA Pipeline
 * Orchestrates OCR, VLM, and code model reasoning
 */
export class ImageQAPipeline {
	/**
	 * Process image and question through the pipeline
	 */
	async process(options: ImageQAOptions): Promise<QAResponse> {
		const { imageData, width, height, userQuestion, devMode = false, preferOnline = true } = options;

		// Step 1: Route (image and code tasks should favor online models)
		const routing = await imageQARouter.route(imageData, width, height, userQuestion, preferOnline);
		imageQARouter.logDecision(routing, devMode);

		// Step 2: Execute based on routing path
		switch (routing.path) {
			case 'ocr_code':
				return this.processOCROnlyPath(routing, options);

			case 'vlm_only':
				return this.processVLMPath(routing, options);

			case 'ocr_vlm_hybrid':
				return this.processHybridPath(routing, options);

			default:
				return {
					answer: 'Unable to process this image type. Please try a different question or image.',
					confidence: 0.3,
					unknowns: ['Unknown routing path'],
				};
		}
	}

	/**
	 * Primary path: OCR → Structured JSON → Code LLM
	 */
	private async processOCROnlyPath(routing: RoutingDecision, options: ImageQAOptions): Promise<QAResponse> {
		const { imageData, mimeType, userQuestion, codeModel, devMode = false } = options;

		// Step 1: Run OCR
		const ocr = getOCRService();
		let ocrResult: OCRResult;

		// Check if we need tiling for high-DPI images
		const totalPixels = options.width * options.height;
		if (totalPixels > 4_000_000) {
			// Tile and process
			ocrResult = await this.tileAndOCR(imageData, mimeType, options.width, options.height);
		} else {
			ocrResult = await ocr.extract(imageData, mimeType);
		}

		if (ocrResult.totalChars < 10) {
			// OCR yielded little text - get region proposals from VLM if available
			if (options.vlmModel || options.allowRemoteModels) {
				if (devMode) console.log('[ImageQA] OCR yielded little text, getting VLM region proposals');
				const regions = await this.getRegionProposals(imageData, mimeType, options.vlmModel, options.allowRemoteModels);

				if (regions.length > 0) {
					// Propose zoom regions to user
					return {
						answer: 'I found very little text in this image. However, I identified some regions that might contain text. Please select a region to zoom in.',
						confidence: 0.3,
						unknowns: ['Cannot read text from full image'],
						needsUserInput: {
							message: 'Click on one of these regions to zoom and extract text:',
							suggestedRegions: regions.map(r => ({
								bbox: r.bbox,
								label: r.label,
							})),
						},
					};
				}

				// Try VLM-only path as fallback
				return this.processVLMPath(routing, options);
			}

			// Otherwise, abstain gracefully
			return {
				answer: 'I was unable to extract significant text from this image. This might be a diagram, chart, or image with very small text.',
				confidence: 0.2,
				unknowns: ['Cannot read text from image'],
				needsUserInput: {
					message: 'Could you describe what type of image this is, or try asking about visual elements instead of text?',
				},
			};
		}

		// Step 2: Normalize to structured JSON
		const structuredData = this.normalizeOCRToJSON(ocrResult);

		// Step 3: Feed to code model for reasoning
		return this.reasonWithCodeModel(structuredData, userQuestion, routing, codeModel, devMode || false);
	}

	/**
	 * VLM-only path for charts/diagrams/photos
	 */
	private async processVLMPath(routing: RoutingDecision, options: ImageQAOptions): Promise<QAResponse> {
		const { allowRemoteModels = false, vlmModel, userQuestion, imageData } = options;

		// Security check for remote model calls
		const securityCheck = checkRemoteModelCall(allowRemoteModels, imageData.length);
		if (!securityCheck.allowed) {
			return {
				answer: securityCheck.reason || 'Remote model call not allowed',
				confidence: 0.1,
				unknowns: ['Security check failed'],
				needsUserInput: {
					message: securityCheck.reason || 'Cannot use remote models for this request.',
				},
			};
		}

		// Check model availability
		if (!vlmModel && !allowRemoteModels) {
			// No local VLM available and remote disabled
			return {
				answer: 'This image appears to be a chart, diagram, or photo that requires vision analysis. However, no local vision model is available and remote models are disabled.',
				confidence: 0.1,
				unknowns: ['No vision model available'],
				needsUserInput: {
					message: 'To analyze this image, please: 1) Install a local vision model (e.g., llava via Ollama), or 2) Enable remote vision models in settings.',
				},
			};
		}

		// Log processing decision
		logImageProcessingDecision(
			'vlm_only',
			routing.imageType,
			routing.questionType,
			allowRemoteModels && !vlmModel,
			vlmModel,
			undefined // logService would be injected if needed
		);

		// VLM integration will be handled by returning structured response
		// The integration layer will call VLM service with image
		return {
			answer: '', // Will be filled by VLM
			confidence: 0.7,
			unknowns: [],
			_needsLLM: true,
			_prompt: this.buildVLMPrompt('analysis', userQuestion),
			_needsVLM: true, // Signal that this needs VLM processing
		} as QAResponse & { _needsLLM?: boolean; _needsVLM?: boolean; _prompt?: string };
	}

	/**
	 * Hybrid path: OCR + VLM
	 */
	private async processHybridPath(routing: RoutingDecision, options: ImageQAOptions): Promise<QAResponse> {
		// Run OCR first
		const ocr = getOCRService();
		const ocrResult = await ocr.extract(options.imageData, options.mimeType);

		// Get VLM layout hints
		const vlmHints = await this.getVLMHints(options);

		// Combine and reason
		const structuredData = this.normalizeOCRToJSON(ocrResult);
		return this.reasonWithCodeModel(structuredData, options.userQuestion, routing, options.codeModel, options.devMode || false, vlmHints);
	}

	/**
	 * Tile high-DPI images and run OCR on each tile
	 */
	private async tileAndOCR(imageData: Uint8Array, mimeType: string, width: number, height: number): Promise<OCRResult> {
		const ocr = getOCRService();
		const tileSize = 2048;
		const overlap = 256; // Overlap to avoid cutting text
		const results: OCRResult[] = [];

		// Create tiles with overlap
		for (let y = 0; y < height; y += tileSize - overlap) {
			for (let x = 0; x < width; x += tileSize - overlap) {
				const tileBbox = {
					x: Math.max(0, x),
					y: Math.max(0, y),
					width: Math.min(tileSize, width - x),
					height: Math.min(tileSize, height - y),
				};

				// Extract region using proper image cropping
				const tileResult = await ocr.extractRegion(imageData, mimeType, tileBbox);
				results.push(tileResult);
			}
		}

		// Merge results (deduplicate overlapping regions)
		return this.mergeOCRResults(results);
	}

	/**
	 * Merge multiple OCR results into one
	 * Deduplicates overlapping blocks from tiled regions
	 */
	private mergeOCRResults(results: OCRResult[]): OCRResult {
		const merged: OCRResult = {
			blocks: [],
			tables: [],
			code_blocks: [],
			errors: [],
			fullText: '',
			totalChars: 0,
		};

		// Use a Set to track unique blocks by position and text
		const seenBlocks = new Set<string>();
		const seenCodeBlocks = new Set<string>();

		for (const result of results) {
			// Deduplicate blocks (overlapping tiles may produce duplicate blocks)
			for (const block of result.blocks) {
				const key = `${block.bbox.x},${block.bbox.y},${block.text}`;
				if (!seenBlocks.has(key)) {
					seenBlocks.add(key);
					merged.blocks.push(block);
				}
			}

			// Deduplicate code blocks
			for (const codeBlock of result.code_blocks) {
				const key = `${codeBlock.bbox.x},${codeBlock.bbox.y},${codeBlock.text}`;
				if (!seenCodeBlocks.has(key)) {
					seenCodeBlocks.add(key);
					merged.code_blocks.push(codeBlock);
				}
			}

			merged.tables.push(...result.tables);
			merged.errors.push(...result.errors);
			merged.fullText += result.fullText + '\n';
		}

		merged.totalChars = merged.fullText.length;
		return merged;
	}

	/**
	 * Normalize OCR result to structured JSON format
	 */
	private normalizeOCRToJSON(ocrResult: OCRResult): string {
		const structure = {
			blocks: ocrResult.blocks.map((b, idx) => ({
				idx,
				bbox: b.bbox,
				text: b.text,
				type: b.type,
				confidence: b.confidence,
			})),
			tables: ocrResult.tables,
			code_blocks: ocrResult.code_blocks.map((b, idx) => ({
				idx,
				bbox: b.bbox,
				text: b.text,
				confidence: b.confidence,
			})),
			errors: ocrResult.errors,
			total_chars: ocrResult.totalChars,
		};

		return JSON.stringify(structure, null, 2);
	}

	/**
	 * Get layout hints from VLM
	 * VLM provides region proposals and semantic layout
	 */
	private async getVLMHints(options: ImageQAOptions): Promise<string> {
		if (!options.vlmModel && !options.allowRemoteModels) {
			return '';
		}

		// VLM integration will be handled by the integration layer
		// For now, return empty - will be populated by VLM service call
		// The integration layer will call VLM with buildVLMPrompt('layout')
		return '';
	}

	/**
	 * Get region proposals from VLM for tiny text
	 */
	async getRegionProposals(imageData: Uint8Array, mimeType: string, vlmModel?: { provider: string; model: string }, allowRemoteModels: boolean = false): Promise<Array<{ bbox: { x: number; y: number; width: number; height: number }; label: string; confidence: number }>> {
		if (!vlmModel && !allowRemoteModels) {
			return [];
		}

		// VLM integration will be handled by the integration layer
		// The integration layer will call VLM with buildVLMPrompt('regions')
		// and parse the JSON response into region proposals
		// For now, return empty array - will be populated by VLM service call
		return [];
	}

	/**
	 * Reason with code model using structured data
	 * This integrates with the LLM service to send the structured OCR data
	 */
	private async reasonWithCodeModel(
		structuredData: string,
		userQuestion: string,
		routing: RoutingDecision,
		codeModel: { provider: string; model: string } | undefined,
		devMode: boolean,
		vlmHints?: string
	): Promise<QAResponse> {
		// Build prompt using template
		const prompt = this.buildCodeModelPrompt(userQuestion, structuredData, routing, vlmHints);

		if (devMode) {
			console.log('[ImageQA] Code model prompt:', prompt.substring(0, 500) + '...');
		}

		// Return structured response that will be processed by the integration layer
		// The integration layer will call the LLM service with this prompt
		return {
			answer: '', // Will be filled by LLM
			confidence: 0.7,
			unknowns: [],
			citedBlocks: [],
			// Signal that this needs LLM processing
			_needsLLM: true,
			_prompt: prompt,
		} as QAResponse & { _needsLLM?: boolean; _prompt?: string };
	}

	/**
	 * Build prompt template for code model reasoning
	 */
	private buildCodeModelPrompt(
		question: string,
		structuredData: string,
		routing: RoutingDecision,
		vlmHints?: string
	): string {
		const imageTypeContext = this.getImageTypeContext(routing.imageType);
		const questionTypeGuidance = this.getQuestionTypeGuidance(routing.questionType);

		return `You are analyzing an image that has been processed with OCR. The extracted text has been structured into JSON format.

Image Type: ${routing.imageType}
${imageTypeContext}

Question Type: ${routing.questionType}
${questionTypeGuidance}

Extracted Data (JSON):
${structuredData}

${vlmHints ? `Layout Hints from Vision Model:\n${vlmHints}\n` : ''}

User Question: ${question}

Please follow these steps:

Step 1: List observed facts
- Review the extracted blocks, tables, and code_blocks
- Identify key information relevant to the question
- Cite specific block indices (e.g., "Block 3: 'Error: cannot read property'")

Step 2: Derive answer
- Answer the user's question based on the extracted facts
- Reference specific blocks, code snippets, or tables when possible
- If the question asks about an error, explain what the error is and potential causes
- If the question asks about code, explain what the code does or identify issues

Step 3: Provide confidence and unknowns
- Confidence: 0-1 score indicating how certain you are about the answer
- Unknowns: List any information that's missing or unclear

Format your response as:
FACTS:
- [list of facts with block citations]

ANSWER:
[your answer with references]

CONFIDENCE: [0.0-1.0]
UNKNOWNS: [list any missing information]`;
	}

	/**
	 * Get context guidance for image type
	 */
	private getImageTypeContext(imageType: ImageType): string {
		switch (imageType) {
			case 'terminal/log':
				return 'This is a terminal or log output. Focus on error messages, stack traces, and execution flow.';
			case 'code_screenshot':
				return 'This is a code screenshot. Extract code accurately and identify syntax, logic, or structure.';
			case 'document/receipt':
				return 'This is a document or receipt. Extract structured information like dates, amounts, line items.';
			case 'UI/app':
				return 'This is a UI screenshot. Identify components, buttons, labels, and layout structure.';
			case 'chart/diagram':
				return 'This is a chart or diagram. Focus on visual relationships and data representation.';
			default:
				return '';
		}
	}

	/**
	 * Get guidance for question type
	 */
	private getQuestionTypeGuidance(questionType: QuestionType): string {
		switch (questionType) {
			case 'extract_text':
				return 'Extract all relevant text accurately and preserve formatting where possible.';
			case 'explain_error':
				return 'Identify the error type, cause, location, and suggest fixes.';
			case 'summarize_logs':
				return 'Provide a concise summary of key events, errors, and outcomes.';
			case 'find_UI_element':
				return 'Describe the location and appearance of the requested UI element.';
			case 'compare':
				return 'Highlight differences, similarities, and key distinctions.';
			default:
				return 'Provide a comprehensive answer based on the extracted information.';
		}
	}

	/**
	 * Build VLM prompt template for layout/region analysis
	 */
	buildVLMPrompt(task: 'layout' | 'regions' | 'analysis', userQuestion?: string): string {
		if (task === 'layout') {
			return `Analyze this image and provide a brief semantic layout description.
Focus on:
- Identifying major regions (e.g., "left panel shows file tree", "right panel shows code editor", "bottom panel shows terminal")
- Noting any areas with tiny text that might need zoom
- Identifying UI elements, charts, or diagrams

Keep response concise (2-3 sentences). Do NOT attempt to read text - just describe layout and structure.`;
		} else if (task === 'analysis') {
			return `Analyze this image and answer the user's question about it.

User Question: ${userQuestion || 'What is shown in this image?'}

Provide a detailed analysis based on what you can see in the image. Be specific and cite visual elements when relevant.`;
		} else {
			return `Analyze this image and identify 1-3 regions that likely contain text that is too small to read in the full image.
For each region, provide:
- Bounding box coordinates (x, y, width, height)
- Brief description of what's in that region

Format as JSON array:
[{"bbox": {"x": 0, "y": 0, "width": 100, "height": 50}, "label": "error message area", "confidence": 0.8}]

Do NOT attempt to read the actual text - just propose regions for zoom.`;
		}
	}
}

// Singleton instance
export const imageQAPipeline = new ImageQAPipeline();

