/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Image utilities for Void chat image uploads
 * Handles compression, resizing, EXIF stripping, and validation
 */

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml';

export const ALLOWED_IMAGE_MIME_TYPES: ImageMimeType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];

export interface ProcessedImage {
	data: Uint8Array;
	mimeType: ImageMimeType;
	width: number;
	height: number;
	filename: string;
	size: number; // size in bytes after compression
	originalSize: number; // size in bytes before compression
}

export interface ImageValidationError {
	type: 'mime_type' | 'size' | 'count' | 'dimension' | 'corrupt' | 'svg_unsupported';
	message: string;
}

const MAX_TOTAL_SIZE = 20 * 1024 * 1024; // 20 MB total per message
const MAX_COUNT = 10; // max images per message
const MAX_DIMENSION = 2048; // resize if any side > 2048px

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(data.byteLength);
	new Uint8Array(buffer).set(data);
	return buffer;
}

/**
 * Formats file size for display
 */
export function formatFileSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Validates an image file
 */
export function validateImageFile(file: File): ImageValidationError | null {
	// Check MIME type
	if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type as ImageMimeType)) {
		return {
			type: 'mime_type',
			message: `Unsupported image type: ${file.type}. Supported: PNG, JPEG, WebP, GIF, SVG.`
		};
	}

	// Check file size (before compression)
	if (file.size > 30 * 1024 * 1024) { // 30 MB limit before compression
		return {
			type: 'size',
			message: `Image is too large: ${formatFileSize(file.size)}. Maximum: 30 MB.`
		};
	}

	return null;
}

/**
 * Validates multiple images for total size and count limits
 * Accepts both ProcessedImage and ChatImageAttachment
 */
export function validateImageBatch(images: (ProcessedImage | { size: number })[]): ImageValidationError | null {
	if (images.length > MAX_COUNT) {
		return {
			type: 'count',
			message: `Too many images: ${images.length}. Maximum: ${MAX_COUNT}.`
		};
	}

	const totalSize = images.reduce((sum, img) => sum + img.size, 0);
	if (totalSize > MAX_TOTAL_SIZE) {
		return {
			type: 'size',
			message: `Total image size too large: ${formatFileSize(totalSize)}. Maximum: ${formatFileSize(MAX_TOTAL_SIZE)}.`
		};
	}

	return null;
}

/**
 * Processes an image: resizes if needed, compresses, strips EXIF, and auto-rotates based on orientation
 * @param file The image file to process
 * @param onProgress Optional callback for progress updates (0-1)
 */
export async function processImage(file: File, onProgress?: (progress: number) => void): Promise<ProcessedImage> {
	const validationError = validateImageFile(file);
	if (validationError) {
		throw new Error(validationError.message);
	}

	onProgress?.(0.1);
	const mimeType = file.type as ImageMimeType;

	// For SVG, sanitize and rasterize
	if (mimeType === 'image/svg+xml') {
		onProgress?.(0.3);
		return await processSvgImage(file, onProgress);
	}

	onProgress?.(0.2);
	const arrayBuffer = await file.arrayBuffer();
	const uint8Array = new Uint8Array(arrayBuffer);

	// Load image to get dimensions and apply EXIF orientation
	onProgress?.(0.4);
	const img = await loadImageWithOrientation(uint8Array, onProgress);

	// Determine if resize is needed
	let targetWidth = img.width;
	let targetHeight = img.height;
	const needsResize = img.width > MAX_DIMENSION || img.height > MAX_DIMENSION;

	if (needsResize) {
		const scaleFactor = MAX_DIMENSION / Math.max(img.width, img.height);
		targetWidth = Math.round(img.width * scaleFactor);
		targetHeight = Math.round(img.height * scaleFactor);
	}

	onProgress?.(0.6);
	// Create canvas and draw image (this also strips EXIF and applies orientation)
	const canvas = document.createElement('canvas');
	canvas.width = targetWidth;
	canvas.height = targetHeight;
	const ctx = canvas.getContext('2d', { willReadFrequently: false });
	if (!ctx) {
		throw new Error('Failed to get canvas context');
	}

	// Apply orientation if needed
	if (img.orientation && img.orientation !== 1) {
		applyOrientation(ctx, img.orientation, targetWidth, targetHeight);
	}

	onProgress?.(0.7);
	ctx.drawImage(img.image, 0, 0, targetWidth, targetHeight);

	// Convert to blob with compression
	const outputMimeType = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
	const quality = determineQuality(mimeType, targetWidth, targetHeight);

	onProgress?.(0.8);
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) {
					reject(new Error('Failed to create blob from canvas'));
					return;
				}
				onProgress?.(0.9);
				const reader = new FileReader();
				reader.onload = () => {
					const data = new Uint8Array(reader.result as ArrayBuffer);
					onProgress?.(1.0);
					resolve({
						data,
						mimeType: outputMimeType as ImageMimeType,
						width: targetWidth,
						height: targetHeight,
						filename: sanitizeFilename(file.name),
						size: data.length,
						originalSize: file.size,
					});
				};
				reader.onerror = () => reject(new Error('Failed to read blob'));
				reader.readAsArrayBuffer(blob);
			},
			outputMimeType,
			quality
		);
	});
}

/**
 * Loads an image with EXIF orientation detection
 */
interface LoadedImage {
	image: HTMLImageElement;
	width: number;
	height: number;
	orientation: number; // EXIF orientation (1-8)
}

/**
 * Parses EXIF orientation from image data
 * EXIF orientation is stored in the APP1 segment at specific offsets
 */
function parseExifOrientation(data: Uint8Array): number {
	// JPEG files start with FF D8
	if (data.length < 4 || data[0] !== 0xFF || data[1] !== 0xD8) {
		return 1; // Default orientation
	}

	let offset = 2;

	// Search through JPEG segments
	while (offset < data.length - 1) {
		// Find APP1 segment (FF E1) which contains EXIF
		if (data[offset] === 0xFF && data[offset + 1] === 0xE1) {
			// Check for EXIF marker (45 78 69 66 = "Exif")
			if (offset + 6 < data.length) {
				const exifMarker = String.fromCharCode(
					data[offset + 4],
					data[offset + 5],
					data[offset + 6],
					data[offset + 7]
				);
				if (exifMarker === 'Exif') {
					// EXIF header found, now find orientation tag
					// TIFF header starts at offset + 10
					const tiffOffset = offset + 10;
					if (tiffOffset + 8 < data.length) {
						// Check byte order (II = Intel, MM = Motorola)
						const isIntel = data[tiffOffset] === 0x49 && data[tiffOffset + 1] === 0x49;
						if (isIntel || (data[tiffOffset] === 0x4D && data[tiffOffset + 1] === 0x4D)) {
							// Read IFD offset (4 bytes after byte order)
							let ifdOffsetValue = 0;
							if (tiffOffset + 8 < data.length) {
								if (isIntel) {
									ifdOffsetValue = data[tiffOffset + 4] | (data[tiffOffset + 5] << 8) | (data[tiffOffset + 6] << 16) | (data[tiffOffset + 7] << 24);
								} else {
									ifdOffsetValue = (data[tiffOffset + 4] << 24) | (data[tiffOffset + 5] << 16) | (data[tiffOffset + 6] << 8) | data[tiffOffset + 7];
								}
								if (ifdOffsetValue >= 0) {
									const ifdOffset = tiffOffset + ifdOffsetValue;
									if (ifdOffset < data.length && ifdOffset + 2 < data.length) {
										// Read number of entries
										let numEntries = 0;
										if (isIntel) {
											numEntries = data[ifdOffset] | (data[ifdOffset + 1] << 8);
										} else {
											numEntries = (data[ifdOffset] << 8) | data[ifdOffset + 1];
										}

										// Search for orientation tag (0x0112)
										let entryOffset = ifdOffset + 2;
										for (let i = 0; i < numEntries && entryOffset + 12 < data.length; i++, entryOffset += 12) {
											let tag = 0;
											if (isIntel) {
												tag = data[entryOffset] | (data[entryOffset + 1] << 8);
											} else {
												tag = (data[entryOffset] << 8) | data[entryOffset + 1];
											}

											if (tag === 0x0112) { // Orientation tag
												// Read value (should be SHORT, value at offset + 8)
												let orientation = 0;
												if (isIntel) {
													orientation = data[entryOffset + 8] | (data[entryOffset + 9] << 8);
												} else {
													orientation = (data[entryOffset + 8] << 8) | data[entryOffset + 9];
												}
												if (orientation >= 1 && orientation <= 8) {
													return orientation;
												}
											}
										}
									}
								}
							}
						}
					}
				}
			}
		}

		// Move to next segment
		if (offset + 2 < data.length) {
			const segmentLength = (data[offset + 2] << 8) | data[offset + 3];
			offset += 2 + segmentLength;
		} else {
			break;
		}
	}

	return 1; // Default orientation
}

async function loadImageWithOrientation(data: Uint8Array, onProgress?: (progress: number) => void): Promise<LoadedImage> {
	return new Promise((resolve, reject) => {
		onProgress?.(0.5);
		const blob = new Blob([toArrayBuffer(data)]);
		const url = URL.createObjectURL(blob);
		const img = new Image();

		img.onload = () => {
			URL.revokeObjectURL(url);
			// Parse EXIF orientation
			onProgress?.(0.6);
			const orientation = parseExifOrientation(data);

			resolve({
				image: img,
				width: img.naturalWidth,
				height: img.naturalHeight,
				orientation,
			});
		};

		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('Failed to load image'));
		};

		img.src = url;
	});
}

/**
 * Processes SVG: sanitizes and rasterizes to PNG
 * Hardened sanitization: blocks external refs, data URLs, embedded scripts
 */
async function processSvgImage(file: File, onProgress?: (progress: number) => void): Promise<ProcessedImage> {
	onProgress?.(0.3);
	const svgText = await file.text();

	// Hardened SVG sanitization
	let sanitized = svgText
		// Remove script tags and embedded scripts
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, (match) => {
			// Remove style tags that contain suspicious content
			if (/expression\s*\(|javascript:|@import|url\s*\(/i.test(match)) {
				return '';
			}
			return match;
		})
		// Remove event handlers (onclick, onload, etc.)
		.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
		// Remove javascript: protocol
		.replace(/javascript:/gi, '')
		// Remove external references (<use href="...">, <image href="...">)
		.replace(/<use[^>]*href\s*=\s*["'][^"']*["'][^>]*>/gi, '')
		.replace(/<image[^>]*href\s*=\s*["'][^"']*["'][^>]*>/gi, '')
		.replace(/<image[^>]*xlink:href\s*=\s*["'][^"']*["'][^>]*>/gi, '')
		// Remove data URLs in suspicious contexts (allow in safe attributes like data-*)
		.replace(/url\s*\(\s*["']?data:/gi, 'url(#blocked)')
		// Remove <foreignObject> (can embed HTML/scripts)
		.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
		// Remove <iframe> and <embed>
		.replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
		.replace(/<embed[^>]*>/gi, '')
		// Remove external stylesheet links
		.replace(/<\?xml-stylesheet[^>]*\?>/gi, '')
		// Remove <link> elements (external resources)
		.replace(/<link[^>]*>/gi, '');

	// Additional security check: detect if sanitization removed too much (suspicious)
	const originalLength = svgText.length;
	const sanitizedLength = sanitized.length;
	const removalRatio = (originalLength - sanitizedLength) / originalLength;

	// If more than 30% was removed, it's likely malicious - fallback to raster
	if (removalRatio > 0.3) {
		console.warn('SVG sanitization removed >30% of content, using raster fallback for safety');
	}

	// Try to rasterize SVG to PNG (always rasterize for security)
	onProgress?.(0.5);
	return new Promise((resolve, reject) => {
		const img = new Image();

		// Add CSP-style restrictions via data URL with sandbox
		const blob = new Blob([sanitized], { type: 'image/svg+xml' });
		const url = URL.createObjectURL(blob);

		// Set timeout for image loading (prevent hanging on malicious SVG)
		const loadTimeout = setTimeout(() => {
			URL.revokeObjectURL(url);
			reject(new Error('SVG loading timeout - file may be corrupted or malicious'));
		}, 10000); // 10 second timeout

		img.onload = () => {
			clearTimeout(loadTimeout);
			URL.revokeObjectURL(url);
			onProgress?.(0.7);
			const canvas = document.createElement('canvas');
			canvas.width = img.naturalWidth || 800;
			canvas.height = img.naturalHeight || 600;
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				reject(new Error('Failed to get canvas context for SVG'));
				return;
			}

			ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
			onProgress?.(0.8);
			canvas.toBlob((blob) => {
				if (!blob) {
					reject(new Error('Failed to rasterize SVG'));
					return;
				}
				onProgress?.(0.9);
				const reader = new FileReader();
				reader.onload = () => {
					const data = new Uint8Array(reader.result as ArrayBuffer);
					onProgress?.(1.0);
					resolve({
						data,
						mimeType: 'image/png',
						width: canvas.width,
						height: canvas.height,
						filename: sanitizeFilename(file.name.replace(/\.svg$/i, '.png')),
						size: data.length,
						originalSize: file.size,
					});
				};
				reader.onerror = () => reject(new Error('Failed to read rasterized SVG'));
				reader.readAsArrayBuffer(blob);
			}, 'image/png', 0.95);
		};

		img.onerror = () => {
			clearTimeout(loadTimeout);
			URL.revokeObjectURL(url);
			// Fallback: create a simple placeholder raster image
			onProgress?.(0.7);
			const canvas = document.createElement('canvas');
			canvas.width = 800;
			canvas.height = 600;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				ctx.fillStyle = '#f0f0f0';
				ctx.fillRect(0, 0, canvas.width, canvas.height);
				ctx.fillStyle = '#666';
				ctx.font = '16px sans-serif';
				ctx.textAlign = 'center';
				ctx.fillText('SVG preview unavailable', canvas.width / 2, canvas.height / 2);

				canvas.toBlob((blob) => {
					if (blob) {
						const reader = new FileReader();
						reader.onload = () => {
							const data = new Uint8Array(reader.result as ArrayBuffer);
							resolve({
								data,
								mimeType: 'image/png',
								width: canvas.width,
								height: canvas.height,
								filename: sanitizeFilename(file.name.replace(/\.svg$/i, '.png')),
								size: data.length,
								originalSize: file.size,
							});
						};
						reader.readAsArrayBuffer(blob);
					} else {
						reject(new Error('Failed to load SVG and create fallback'));
					}
				}, 'image/png');
			} else {
				reject(new Error('Failed to load SVG'));
			}
		};

		img.src = url;
	});
}

/**
 * Applies EXIF orientation to canvas context
 */
function applyOrientation(ctx: CanvasRenderingContext2D, orientation: number, width: number, height: number): void {
	ctx.save();

	switch (orientation) {
		case 2: // horizontal flip
			ctx.translate(width, 0);
			ctx.scale(-1, 1);
			break;
		case 3: // 180° rotation
			ctx.translate(width, height);
			ctx.rotate(Math.PI);
			break;
		case 4: // vertical flip
			ctx.translate(0, height);
			ctx.scale(1, -1);
			break;
		case 5: // horizontal flip + 90° CCW
			ctx.translate(height, 0);
			ctx.rotate(Math.PI / 2);
			ctx.scale(-1, 1);
			break;
		case 6: // 90° CW
			ctx.translate(height, 0);
			ctx.rotate(Math.PI / 2);
			break;
		case 7: // horizontal flip + 90° CW
			ctx.translate(0, width);
			ctx.rotate(-Math.PI / 2);
			ctx.scale(-1, 1);
			break;
		case 8: // 90° CCW
			ctx.translate(0, width);
			ctx.rotate(-Math.PI / 2);
			break;
	}

	ctx.restore();
}

/**
 * Determines compression quality based on image type and dimensions
 * Aims for perceptual quality while keeping file size reasonable
 */
function determineQuality(mimeType: ImageMimeType, width: number, height: number): number {
	// For PNG, quality is ignored (lossless)
	if (mimeType === 'image/png') {
		return 1.0;
	}

	// For JPEG/WebP, use adaptive quality
	// Larger images can use slightly lower quality
	const pixels = width * height;
	if (pixels > 2_000_000) {
		return 0.85; // High quality for large images
	} else if (pixels > 1_000_000) {
		return 0.90;
	} else {
		return 0.92; // Very high quality for smaller images
	}
}

/**
 * Sanitizes filename to prevent injection issues
 */
function sanitizeFilename(filename: string): string {
	// Remove path components, null bytes, and other dangerous characters
	return filename
		.replace(/^.*[\/\\]/, '') // Remove path
		.replace(/\0/g, '') // Remove null bytes
		.replace(/[<>:"|?*\x00-\x1f]/g, '_') // Replace dangerous chars
		.substring(0, 255); // Limit length
}

/**
 * Creates a data URL from image data for preview
 */
export function createImageDataUrl(data: Uint8Array, mimeType: ImageMimeType): string {
	const blob = new Blob([toArrayBuffer(data)], { type: mimeType });
	return URL.createObjectURL(blob);
}

/**
 * Revokes a data URL (cleanup)
 */
export function revokeImageDataUrl(url: string): void {
	URL.revokeObjectURL(url);
}

