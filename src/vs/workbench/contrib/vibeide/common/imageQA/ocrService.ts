/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * OCR Service for extracting text from images
 * Uses Tesseract.js for browser-based OCR
 */

export interface OCRBlock {
	bbox: { x: number; y: number; width: number; height: number };
	text: string;
	type: 'text' | 'code' | 'table' | 'heading' | 'list';
	confidence: number;
}

export interface OCRResult {
	blocks: OCRBlock[];
	tables: Array<{ bbox: OCRBlock['bbox']; rows: string[][] }>;
	code_blocks: OCRBlock[];
	errors: string[]; // any parsing/recognition errors
	fullText: string;
	totalChars: number;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(data.byteLength);
	new Uint8Array(buffer).set(data);
	return buffer;
}

/**
 * OCR Service interface
 */
export interface IOCRService {
	/**
	 * Extract text from image
	 * @param imageData Image as Uint8Array
	 * @param mimeType Image MIME type
	 * @returns Structured OCR result
	 */
	extract(imageData: Uint8Array, mimeType: string): Promise<OCRResult>;

	/**
	 * Extract text from a tiled region of image
	 * @param imageData Full image data
	 * @param mimeType Image MIME type
	 * @param bbox Bounding box {x, y, width, height} to extract from
	 * @returns OCR result for that region
	 */
	extractRegion(imageData: Uint8Array, mimeType: string, bbox: { x: number; y: number; width: number; height: number }): Promise<OCRResult>;
}

/**
 * Browser-based OCR using Tesseract.js
 * Dynamically loaded to avoid bundle size bloat
 */
export class TesseractOCRService implements IOCRService {
	private tesseractWorker: any = null;
	private workerInitialized = false;

	private async ensureWorker(): Promise<void> {
		if (this.workerInitialized && this.tesseractWorker) return;

		try {
			// Dynamic import to avoid bundle bloat
			// tesseract.js is an optional dependency - ignore TypeScript error if not installed
			// @ts-expect-error - tesseract.js may not be installed yet
			const tesseractModule = await import('tesseract.js').catch(() => null);
			if (!tesseractModule) {
				throw new Error('tesseract.js not installed. Run: npm install tesseract.js');
			}
			const { createWorker } = tesseractModule;
			this.tesseractWorker = await createWorker('eng');
			this.workerInitialized = true;
		} catch (error: any) {
			console.error('Failed to initialize Tesseract worker:', error);
			throw new Error(`OCR service unavailable: ${error.message || 'Tesseract.js failed to load'}`);
		}
	}

	async extract(imageData: Uint8Array, mimeType: string): Promise<OCRResult> {
		await this.ensureWorker();

		try {
			const result = await this.tesseractWorker.recognize(imageData);

			// Parse Tesseract result into structured format
			const blocks: OCRBlock[] = [];
			const code_blocks: OCRBlock[] = [];
			const errors: string[] = [];

			// Process words into blocks (simple grouping by proximity)
			if (result.data.words) {
				let currentBlock: OCRBlock | null = null;

				for (const word of result.data.words) {
					const bbox = {
						x: word.bbox.x0,
						y: word.bbox.y0,
						width: word.bbox.x1 - word.bbox.x0,
						height: word.bbox.y1 - word.bbox.y0,
					};

					// Detect code-like text (simple heuristics)
					const isCode = /^[{}[\]()=><;:+\-*\/\\|&!@#$%^_]+$/.test(word.text) ||
						/^(function|const|let|var|if|for|while|return|import|export)/i.test(word.text);

					const block: OCRBlock = {
						bbox,
						text: word.text,
						type: isCode ? 'code' : 'text',
						confidence: word.confidence || 0,
					};

					if (isCode) {
						code_blocks.push(block);
					}

					// Simple grouping: merge words on same line
					if (!currentBlock || Math.abs(bbox.y - currentBlock.bbox.y) > bbox.height * 0.5) {
						if (currentBlock) blocks.push(currentBlock);
						currentBlock = { ...block };
					} else {
						currentBlock.text += ' ' + block.text;
						// Merge bounding boxes
						currentBlock.bbox = {
							x: Math.min(currentBlock.bbox.x, bbox.x),
							y: Math.min(currentBlock.bbox.y, bbox.y),
							width: Math.max(currentBlock.bbox.x + currentBlock.bbox.width, bbox.x + bbox.width) - Math.min(currentBlock.bbox.x, bbox.x),
							height: Math.max(currentBlock.bbox.y + currentBlock.bbox.height, bbox.y + bbox.height) - Math.min(currentBlock.bbox.y, bbox.y),
						};
					}
				}

				if (currentBlock) blocks.push(currentBlock);
			}

			// Extract full text
			const fullText = result.data.text || '';

			return {
				blocks,
				tables: [], // Table detection would require additional processing
				code_blocks,
				errors,
				fullText,
				totalChars: fullText.length,
			};
		} catch (error: any) {
			return {
				blocks: [],
				tables: [],
				code_blocks: [],
				errors: [error.message || 'OCR failed'],
				fullText: '',
				totalChars: 0,
			};
		}
	}

	async extractRegion(
		imageData: Uint8Array,
		mimeType: string,
		bbox: { x: number; y: number; width: number; height: number }
	): Promise<OCRResult> {
		// Crop the image to the region before OCR for better accuracy
		const blob = new Blob([toArrayBuffer(imageData)], { type: mimeType });
		const img = new Image();
		const url = URL.createObjectURL(blob);

		return new Promise((resolve, reject) => {
			img.onload = async () => {
				URL.revokeObjectURL(url);

				try {
					// Create canvas and crop to region
					const canvas = document.createElement('canvas');
					canvas.width = bbox.width;
					canvas.height = bbox.height;
					const ctx = canvas.getContext('2d');
					if (!ctx) {
						reject(new Error('Failed to get canvas context'));
						return;
					}

					// Draw the cropped region
					ctx.drawImage(
						img,
						bbox.x, bbox.y, bbox.width, bbox.height,
						0, 0, bbox.width, bbox.height
					);

					// Convert canvas to blob then to Uint8Array
					const croppedBlob = await new Promise<Blob>((res, rej) => {
						canvas.toBlob((blob) => {
							if (blob) res(blob);
							else rej(new Error('Failed to create blob'));
						}, mimeType);
					});

					const croppedArrayBuffer = await croppedBlob.arrayBuffer();
					const croppedData = new Uint8Array(croppedArrayBuffer);

					// Run OCR on cropped image
					const result = await this.extract(croppedData, mimeType);

					// Adjust bounding boxes to be relative to original image coordinates
					const adjusted = {
						...result,
						blocks: result.blocks.map(b => ({
							...b,
							bbox: {
								x: b.bbox.x + bbox.x,
								y: b.bbox.y + bbox.y,
								width: b.bbox.width,
								height: b.bbox.height,
							}
						})),
						code_blocks: result.code_blocks.map(b => ({
							...b,
							bbox: {
								x: b.bbox.x + bbox.x,
								y: b.bbox.y + bbox.y,
								width: b.bbox.width,
								height: b.bbox.height,
							}
						})),
					};

					resolve(adjusted);
				} catch (error) {
					reject(error);
				}
			};

			img.onerror = () => {
				URL.revokeObjectURL(url);
				reject(new Error('Failed to load image for region extraction'));
			};

			img.src = url;
		});
	}

	async terminate(): Promise<void> {
		if (this.tesseractWorker) {
			await this.tesseractWorker.terminate();
			this.tesseractWorker = null;
			this.workerInitialized = false;
		}
	}
}

// Singleton instance
let ocrServiceInstance: IOCRService | null = null;

/**
 * Get the OCR service instance
 * Lazy-loads Tesseract.js
 */
export function getOCRService(): IOCRService {
	if (!ocrServiceInstance) {
		ocrServiceInstance = new TesseractOCRService();
	}
	return ocrServiceInstance;
}

