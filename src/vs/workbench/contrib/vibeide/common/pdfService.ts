/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { AppResourcePath, FileAccess, nodeModulesPath } from '../../../../base/common/network.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';

export interface PDFPage {
	pageNumber: number;
	text: string;
	images?: Array<{
		data: Uint8Array;
		mimeType: string;
		width: number;
		height: number;
	}>;
}

export interface PDFDocument {
	filename: string;
	pageCount: number;
	pages: PDFPage[];
	metadata?: {
		title?: string;
		author?: string;
		subject?: string;
	};
}

export interface PDFExtractionOptions {
	extractImages?: boolean;
	extractMetadata?: boolean;
	pageRange?: { start: number; end: number }; // 1-indexed, inclusive
	cancellationToken?: CancellationToken; // For cancellation support
}

export interface PDFExtractionWithPreviewsResult extends PDFDocument {
	pagePreviews?: string[]; // data URLs for page thumbnails
}

export interface IPDFService {
	/**
	 * Extract text and images from a PDF file
	 */
	extractPDF(file: File | Uint8Array, options?: PDFExtractionOptions): Promise<PDFDocument>;

	/**
	 * Extract PDF with page previews in a single pass (optimized)
	 * This is more efficient than calling extractPDF + getPagePreview separately
	 */
	extractPDFWithPreviews(
		file: File | Uint8Array,
		options?: PDFExtractionOptions & {
			previewPages?: number[]; // page numbers to generate previews for (1-indexed)
			previewMaxWidth?: number;
			previewMaxHeight?: number;
		}
	): Promise<PDFExtractionWithPreviewsResult>;

	/**
	 * Get a preview image for a specific page (for UI thumbnails)
	 */
	getPagePreview(file: File | Uint8Array, pageNumber: number, maxWidth?: number, maxHeight?: number): Promise<string>; // returns data URL

	/**
	 * Check if PDF.js is available
	 */
	isPDFJSAvailable(): boolean;
}

/**
 * Browser-based PDF service using PDF.js
 * Dynamically loads PDF.js to avoid bundle bloat
 */
export class PDFService implements IPDFService {
	private pdfjsLib: any = null;
	private initialized = false;

	private async ensureInitialized(): Promise<void> {
		if (this.initialized && this.pdfjsLib) return;

		try {
			// Try multiple approaches to load PDF.js (ESM module)
			let pdfjs: any = null;
			let lastError: unknown = null;

			// Approach 1: Try dynamic import with file URI
			try {
				const resourcePath: AppResourcePath = `${nodeModulesPath}/pdfjs-dist/build/pdf.mjs`;
				const fileUri = FileAccess.asBrowserUri(resourcePath).toString(true);
				const mod = await import(fileUri);
				pdfjs = (mod as any).default ?? mod;
				if (pdfjs && pdfjs.getDocument) {
					// Set worker source to disable workers (use empty string or point to worker file)
					// PDF.js v5 requires workerSrc to be set, but we can disable workers via getDocument options
					if (pdfjs.GlobalWorkerOptions) {
						const workerPath: AppResourcePath = `${nodeModulesPath}/pdfjs-dist/build/pdf.worker.mjs`;
						const workerUri = FileAccess.asBrowserUri(workerPath).toString(true);
						pdfjs.GlobalWorkerOptions.workerSrc = workerUri;
					}
					this.pdfjsLib = pdfjs;
					this.initialized = true;
					return;
				}
			} catch (error) {
				lastError = error;
			}

			// Approach 2: Try dynamic import with bare specifiers (for bundlers/webpack)
			const candidates = [
				'pdfjs-dist/build/pdf.mjs',
				'pdfjs-dist/build/pdf.js',
				'pdfjs-dist/build/pdf',
			] as const;

			for (const specifier of candidates) {
				try {
					const mod = await import(specifier);
					pdfjs = (mod as any).default ?? mod;
					if (pdfjs && pdfjs.getDocument) {
						break;
					}
				} catch (error) {
					lastError = error;
				}
			}

			if (!pdfjs || !pdfjs.getDocument) {
				throw lastError ?? new Error('Unable to load pdfjs module');
			}

			// Set worker source to disable workers (use empty string or point to worker file)
			// PDF.js v5 requires workerSrc to be set, but we can disable workers via getDocument options
			if (pdfjs.GlobalWorkerOptions) {
				const workerPath: AppResourcePath = `${nodeModulesPath}/pdfjs-dist/build/pdf.worker.mjs`;
				const workerUri = FileAccess.asBrowserUri(workerPath).toString(true);
				pdfjs.GlobalWorkerOptions.workerSrc = workerUri;
			}

			this.pdfjsLib = pdfjs;
			this.initialized = true;
		} catch (error: any) {
			console.error('Failed to initialize PDF.js:', error);
			throw new Error(`PDF.js failed to load: ${error?.message || error || 'Unknown error'}`);
		}
	}

	isPDFJSAvailable(): boolean {
		return this.initialized && this.pdfjsLib !== null;
	}

	async extractPDF(file: File | Uint8Array, options: PDFExtractionOptions = {}): Promise<PDFDocument> {
		await this.ensureInitialized();

		const { extractImages = false, extractMetadata = true, pageRange, cancellationToken } = options;

		// Convert File to Uint8Array if needed
		let data: Uint8Array;
		if (file instanceof File) {
			data = new Uint8Array(await file.arrayBuffer());
		} else {
			data = file;
		}

		// Check cancellation before loading PDF
		if (cancellationToken?.isCancellationRequested) {
			throw new Error('PDF extraction cancelled');
		}

		// Disable workers by using useWorkerFetch: false and useSystemFonts: false
		// This forces PDF.js to run on the main thread
		const loadingTask = this.pdfjsLib.getDocument({
			data,
			useWorkerFetch: false,
			useSystemFonts: false,
			verbosity: 0 // Suppress warnings
		});
		const pdf = await loadingTask.promise;

		const filename = file instanceof File ? file.name : 'document.pdf';
		const pageCount = pdf.numPages;

		// Determine page range
		const startPage = pageRange?.start ?? 1;
		const endPage = pageRange?.end ?? pageCount;
		const actualStart = Math.max(1, Math.min(startPage, pageCount));
		const actualEnd = Math.max(actualStart, Math.min(endPage, pageCount));

		const pages: PDFPage[] = [];

		// Extract metadata if requested
		let metadata: PDFDocument['metadata'] | undefined;
		if (extractMetadata) {
			try {
				const info = await pdf.getMetadata();
				metadata = {
					title: info.info?.Title,
					author: info.info?.Author,
					subject: info.info?.Subject,
				};
			} catch (e) {
				// Metadata extraction is optional
			}
		}

		// Extract pages with chunking and throttling for large PDFs
		const PAGE_CHUNK_SIZE = 10; // Process 10 pages at a time

		// Helper to yield to event loop
		const yieldToEventLoop = (): Promise<void> => {
			return new Promise(resolve => {
				if (typeof requestIdleCallback !== 'undefined') {
					requestIdleCallback(() => resolve(), { timeout: 50 });
				} else {
					setTimeout(() => resolve(), 0);
				}
			});
		};

		for (let chunkStart = actualStart; chunkStart <= actualEnd; chunkStart += PAGE_CHUNK_SIZE) {
			// Check cancellation before processing each chunk
			if (cancellationToken?.isCancellationRequested) {
				throw new Error('PDF extraction cancelled');
			}

			const chunkEnd = Math.min(chunkStart + PAGE_CHUNK_SIZE - 1, actualEnd);

			// Process chunk
			for (let pageNum = chunkStart; pageNum <= chunkEnd; pageNum++) {
				const page = await pdf.getPage(pageNum);
				const textContent = await page.getTextContent();

				// Extract text
				const textItems = textContent.items
					.filter((item: any) => item.str)
					.map((item: any) => item.str);
				const text = textItems.join(' ');

				const pdfPage: PDFPage = {
					pageNumber: pageNum,
					text,
				};

				// Extract images if requested
				if (extractImages) {
					const images: PDFPage['images'] = [];

					// PDF.js operator list contains image operations
					// This is a simplified extraction - full implementation would parse operators
					// For now, we'll extract embedded images from the page
					// Note: Full image extraction from PDF operators is complex
					// This is a placeholder - would need to parse Do operators and XObject streams
					try {
						// Placeholder for future image extraction implementation
						// const operatorList = await page.getOperatorList();
						// const viewport = page.getViewport({ scale: 1.0 });
					} catch (e) {
						// Image extraction is optional
					}

					if (images.length > 0) {
						pdfPage.images = images;
					}
				}

				pages.push(pdfPage);
			}

			// Yield to event loop after each chunk to keep UI responsive
			if (chunkEnd < actualEnd) {
				await yieldToEventLoop();
			}
		}

		return {
			filename,
			pageCount,
			pages,
			metadata,
		};
	}

	async extractPDFWithPreviews(
		file: File | Uint8Array,
		options: PDFExtractionOptions & {
			previewPages?: number[];
			previewMaxWidth?: number;
			previewMaxHeight?: number;
		} = {}
	): Promise<PDFExtractionWithPreviewsResult> {
		await this.ensureInitialized();

		const { extractImages = false, extractMetadata = true, pageRange, previewPages, previewMaxWidth = 200, previewMaxHeight = 300 } = options;

		// Convert File to Uint8Array if needed (single read)
		let data: Uint8Array;
		if (file instanceof File) {
			data = new Uint8Array(await file.arrayBuffer());
		} else {
			data = file;
		}

		// Load PDF document once (reused for both extraction and previews)
		const loadingTask = this.pdfjsLib.getDocument({
			data,
			useWorkerFetch: false,
			useSystemFonts: false,
			verbosity: 0
		});
		const pdf = await loadingTask.promise;

		const filename = file instanceof File ? file.name : 'document.pdf';
		const pageCount = pdf.numPages;

		// Determine page range
		const startPage = pageRange?.start ?? 1;
		const endPage = pageRange?.end ?? pageCount;
		const actualStart = Math.max(1, Math.min(startPage, pageCount));
		const actualEnd = Math.max(actualStart, Math.min(endPage, pageCount));

		const pages: PDFPage[] = [];

		// Extract metadata if requested
		let metadata: PDFDocument['metadata'] | undefined;
		if (extractMetadata) {
			try {
				const info = await pdf.getMetadata();
				metadata = {
					title: info.info?.Title,
					author: info.info?.Author,
					subject: info.info?.Subject,
				};
			} catch (e) {
				// Metadata extraction is optional
			}
		}

		// Extract pages with chunking and throttling for large PDFs
		const PAGE_CHUNK_SIZE = 10; // Process 10 pages at a time

		// Helper to yield to event loop
		const yieldToEventLoop = (): Promise<void> => {
			return new Promise(resolve => {
				if (typeof requestIdleCallback !== 'undefined') {
					requestIdleCallback(() => resolve(), { timeout: 50 });
				} else {
					setTimeout(() => resolve(), 0);
				}
			});
		};

		for (let chunkStart = actualStart; chunkStart <= actualEnd; chunkStart += PAGE_CHUNK_SIZE) {
			const chunkEnd = Math.min(chunkStart + PAGE_CHUNK_SIZE - 1, actualEnd);

			// Process chunk
			for (let pageNum = chunkStart; pageNum <= chunkEnd; pageNum++) {
				const page = await pdf.getPage(pageNum);
				const textContent = await page.getTextContent();

				// Extract text
				const textItems = textContent.items
					.filter((item: any) => item.str)
					.map((item: any) => item.str);
				const text = textItems.join(' ');

				const pdfPage: PDFPage = {
					pageNumber: pageNum,
					text,
				};

				// Extract images if requested
				if (extractImages) {
					const images: PDFPage['images'] = [];
					try {
						// Placeholder for future image extraction implementation
					} catch (e) {
						// Image extraction is optional
					}

					if (images.length > 0) {
						pdfPage.images = images;
					}
				}

				pages.push(pdfPage);
			}

			// Yield to event loop after each chunk to keep UI responsive
			if (chunkEnd < actualEnd) {
				await yieldToEventLoop();
			}
		}

		// Generate previews for specified pages (reusing the loaded PDF document)
		const pagePreviews: string[] = [];
		if (previewPages && previewPages.length > 0) {
			// Generate previews in parallel for better performance
			const previewPromises = previewPages.map(async (pageNumber, index) => {
				if (pageNumber < 1 || pageNumber > pageCount) {
					return { index, preview: null };
				}
				try {
					const page = await pdf.getPage(pageNumber);
					const viewport = page.getViewport({ scale: 1.0 });

					// Calculate scale to fit within max dimensions
					const scale = Math.min(previewMaxWidth / viewport.width, previewMaxHeight / viewport.height, 1.0);
					const scaledViewport = page.getViewport({ scale });

					// Render to canvas
					const canvas = document.createElement('canvas');
					canvas.width = scaledViewport.width;
					canvas.height = scaledViewport.height;

					const context = canvas.getContext('2d');
					if (!context) {
						throw new Error('Failed to get canvas context');
					}

					await page.render({
						canvasContext: context,
						viewport: scaledViewport,
					}).promise;

					return { index, preview: canvas.toDataURL('image/png') };
				} catch (e) {
					console.warn(`Failed to generate preview for page ${pageNumber}:`, e);
					return { index, preview: null };
				}
			});

			const previewResults = await Promise.all(previewPromises);
			// Sort by original index and filter out null results
			previewResults
				.sort((a, b) => a.index - b.index)
				.forEach(({ preview }) => {
					if (preview) {
						pagePreviews.push(preview);
					}
				});
		}

		return {
			filename,
			pageCount,
			pages,
			metadata,
			pagePreviews: pagePreviews.length > 0 ? pagePreviews : undefined,
		};
	}

	async getPagePreview(
		file: File | Uint8Array,
		pageNumber: number,
		maxWidth: number = 200,
		maxHeight: number = 300
	): Promise<string> {
		await this.ensureInitialized();

		// Convert File to Uint8Array if needed
		let data: Uint8Array;
		if (file instanceof File) {
			data = new Uint8Array(await file.arrayBuffer());
		} else {
			data = file;
		}

		// Disable workers by using useWorkerFetch: false and useSystemFonts: false
		// This forces PDF.js to run on the main thread
		const loadingTask = this.pdfjsLib.getDocument({
			data,
			useWorkerFetch: false,
			useSystemFonts: false,
			verbosity: 0 // Suppress warnings
		});
		const pdf = await loadingTask.promise;

		if (pageNumber < 1 || pageNumber > pdf.numPages) {
			throw new Error(`Page ${pageNumber} out of range (1-${pdf.numPages})`);
		}

		const page = await pdf.getPage(pageNumber);
		const viewport = page.getViewport({ scale: 1.0 });

		// Calculate scale to fit within max dimensions
		const scale = Math.min(maxWidth / viewport.width, maxHeight / viewport.height, 1.0);
		const scaledViewport = page.getViewport({ scale });

		// Render to canvas
		const canvas = document.createElement('canvas');
		canvas.width = scaledViewport.width;
		canvas.height = scaledViewport.height;

		const context = canvas.getContext('2d');
		if (!context) {
			throw new Error('Failed to get canvas context');
		}

		await page.render({
			canvasContext: context,
			viewport: scaledViewport,
		}).promise;

		return canvas.toDataURL('image/png');
	}
}

// Singleton instance
let pdfServiceInstance: IPDFService | null = null;

export function getPDFService(): IPDFService {
	if (!pdfServiceInstance) {
		pdfServiceInstance = new PDFService();
	}
	return pdfServiceInstance;
}

