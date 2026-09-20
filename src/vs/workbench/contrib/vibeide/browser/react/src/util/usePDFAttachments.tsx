/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// @ts-nocheck — bundled by vibeide browser/react/build.js; excluded from vscode src typecheck hygiene
import { vibeLog } from '../../../../common/vibeLog.js';
import { useState, useCallback, useRef } from 'react';
import { ChatPDFAttachment } from '../../../../common/chatThreadServiceTypes.js';
import { getPDFService, IPDFService } from '../../../../common/pdfService.js';
import { describeOcrPages, pageHeading } from '../../../../common/pdfTextLayer.js';
import { getOCRService } from '../../../../common/imageQA/ocrService.js';

export interface UsePDFAttachmentsReturn {
	attachments: ChatPDFAttachment[];
	addPDFs: (files: File[]) => Promise<void>;
	removePDF: (id: string) => void;
	retryPDF: (id: string) => Promise<void>;
	cancelPDF: (id: string) => void;
	clearAll: () => void;
	updateSelectedPages: (id: string, pages: number[]) => void;
	focusedIndex: number | null;
	setFocusedIndex: (index: number | null) => void;
	validationError: string | null;
}

const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_PDFS = 5; // Maximum number of PDFs per message

/**
 * Hook to manage PDF attachments in the chat composer
 */
export function usePDFAttachments(): UsePDFAttachmentsReturn {
	const [attachments, setAttachments] = useState<ChatPDFAttachment[]>([]);
	const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
	const [validationError, setValidationError] = useState<string | null>(null);
	const processingRef = useRef<Set<string>>(new Set());
	const cancelRef = useRef<Map<string, () => void>>(new Map());
	const originalFilesRef = useRef<Map<string, File>>(new Map());
	const pdfServiceRef = useRef<IPDFService | null>(null);

	// Lazy load PDF service
	const getPDFServiceInstance = useCallback(async (): Promise<IPDFService> => {
		if (!pdfServiceRef.current) {
			pdfServiceRef.current = getPDFService();
		}
		return pdfServiceRef.current;
	}, []);

	const addPDFs = useCallback(async (files: File[]) => {
		setValidationError(null);

		// Validate files
		for (const file of files) {
			if (file.type !== 'application/pdf') {
				setValidationError(`${file.name} is not a PDF file.`);
				return;
			}
			if (file.size > MAX_PDF_SIZE) {
				setValidationError(`${file.name} is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum: ${MAX_PDF_SIZE / 1024 / 1024}MB.`);
				return;
			}
		}

		// Check count limit
		if (attachments.length + files.length > MAX_PDFS) {
			setValidationError(`Too many PDFs: ${attachments.length + files.length}. Maximum: ${MAX_PDFS} PDFs per message.`);
			return;
		}

		// Create placeholders for all files immediately
		const fileIds = files.map(() => `${Date.now()}-${Math.random().toString(36).substring(7)}`);
		const placeholders: ChatPDFAttachment[] = files.map((file, index) => ({
			id: fileIds[index],
			data: new Uint8Array(0),
			filename: file.name,
			size: file.size,
			uploadStatus: 'pending' as const,
		}));

		setAttachments(prev => [...prev, ...placeholders]);

		// Store original files and setup cancellation for all
		files.forEach((file, index) => {
			const id = fileIds[index];
			originalFilesRef.current.set(id, file);
			processingRef.current.add(id);

			const cancelFn = () => {
				processingRef.current.delete(id);
				cancelRef.current.delete(id);
				originalFilesRef.current.delete(id);
				setAttachments(prev => prev.filter(att => att.id !== id));
			};
			cancelRef.current.set(id, cancelFn);
		});

		// Process all PDFs in parallel for better performance
		const pdfService = await getPDFServiceInstance();
		const processingPromises = files.map(async (file, index) => {
			const id = fileIds[index];
			let cancelled = false;
			const checkCancelled = () => {
				if (!processingRef.current.has(id)) {
					cancelled = true;
				}
				return cancelled;
			};

			const updateProgress = (progress: number, status: ChatPDFAttachment['uploadStatus'] = 'uploading') => {
				if (checkCancelled()) {return;}
				setAttachments(prev => prev.map(att =>
					att.id === id
						? { ...att, uploadStatus: status, uploadProgress: progress }
						: att
				));
			};

			try {
				// Step 1: Read file once (optimized - single read)
				updateProgress(0.1, 'uploading');
				const arrayBuffer = await file.arrayBuffer();
				if (checkCancelled()) {return;}

				// Step 2: Convert to Uint8Array
				updateProgress(0.3, 'uploading');
				const data = new Uint8Array(arrayBuffer);
				if (checkCancelled()) {return;}

				// Step 3: Extract PDF with previews in a single optimized pass
				// This reuses the loaded PDF document and processes everything together
				updateProgress(0.5, 'processing');

				// Use extractPDFWithPreviews to do everything in one pass
				// We'll extract all pages but only generate previews for first 3
				const previewPageCount = 3; // Generate previews for first 3 pages
				// Note: previewPages are 1-indexed, so we generate for pages 1, 2, 3
				const previewPageNumbers = Array.from({ length: previewPageCount }, (_, i) => i + 1);

				const pdfDocWithPreviews = await pdfService.extractPDFWithPreviews(data, {
					// Сканированная страница иначе приезжает пустой строкой: текста в PDF нет, есть
					// картинка. Распознаём её нашим же OCR — качество ниже текстового слоя, и об
					// этом сказано в собранном тексте.
					ocrPage: async (_pageNumber, pngDataUrl) => {
						const base64 = pngDataUrl.slice(pngDataUrl.indexOf(',') + 1);
						const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
						const result = await getOCRService().extract(bytes, 'image/png');
						// Именно `fullText`: поля `text` у результата нет, и прежнее `result.text`
						// всегда давало пустую строку — распознанное терялось молча.
						return result.fullText ?? '';
					},
					extractImages: false,
					extractMetadata: true,
					previewPages: previewPageNumbers, // Only generate previews for first 3 pages
					previewMaxWidth: 200,
					previewMaxHeight: 300,
				});
				if (checkCancelled()) {return;}

				// Extract text from all pages
				updateProgress(0.9, 'processing');
				const selectedPages = Array.from({ length: pdfDocWithPreviews.pageCount }, (_, i) => i + 1);
				const ocrPages = pdfDocWithPreviews.pages.filter(p => p.viaOcr).map(p => p.pageNumber);
				const ocrNote = describeOcrPages(ocrPages);
				const pagesText = pdfDocWithPreviews.pages.map(p => `${pageHeading(p.pageNumber, !!p.viaOcr)}\n${p.text}`).join('\n\n');
				const extractedText = ocrNote ? `${ocrNote}\n\n${pagesText}` : pagesText;

				if (checkCancelled()) {return;}

				// Update attachment with extracted data
				setAttachments(prev => prev.map(att =>
					att.id === id
						? {
							...att,
							data,
							pageCount: pdfDocWithPreviews.pageCount,
							selectedPages,
							extractedText,
							pagePreviews: pdfDocWithPreviews.pagePreviews || [],
							uploadStatus: 'success',
							uploadProgress: 1,
						}
						: att
				));

				processingRef.current.delete(id);
				cancelRef.current.delete(id);
			} catch (error: unknown) {
				if (checkCancelled()) {return;}
				vibeLog.error('usePDFAttachments', 'Error processing PDF:', error);
				const errorMessage = (error as { message?: string } | null)?.message;
				setAttachments(prev => prev.map(att =>
					att.id === id
						? {
							...att,
							uploadStatus: 'failed',
							error: errorMessage || 'Failed to process PDF',
						}
						: att
				));
				processingRef.current.delete(id);
				cancelRef.current.delete(id);
			}
		});

		// Wait for all PDFs to process (they run in parallel)
		await Promise.allSettled(processingPromises);
	}, [attachments.length, getPDFServiceInstance]);

	const removePDF = useCallback((id: string) => {
		cancelRef.current.get(id)?.();
		setAttachments(prev => prev.filter(att => att.id !== id));
		originalFilesRef.current.delete(id);
	}, []);

	const retryPDF = useCallback(async (id: string) => {
		const originalFile = originalFilesRef.current.get(id);
		if (!originalFile) {return;}
		removePDF(id);
		await addPDFs([originalFile]);
	}, [addPDFs, removePDF]);

	const cancelPDF = useCallback((id: string) => {
		cancelRef.current.get(id)?.();
	}, []);

	const clearAll = useCallback(() => {
		attachments.forEach(att => cancelRef.current.get(att.id)?.());
		setAttachments([]);
		processingRef.current.clear();
		cancelRef.current.clear();
		originalFilesRef.current.clear();
		setValidationError(null);
	}, [attachments]);

	const updateSelectedPages = useCallback((id: string, pages: number[]) => {
		setAttachments(prev => prev.map(att =>
			att.id === id
				? { ...att, selectedPages: pages }
				: att
		));
	}, []);

	return {
		attachments,
		addPDFs,
		removePDF,
		retryPDF,
		cancelPDF,
		clearAll,
		updateSelectedPages,
		focusedIndex,
		setFocusedIndex,
		validationError,
	};
}

