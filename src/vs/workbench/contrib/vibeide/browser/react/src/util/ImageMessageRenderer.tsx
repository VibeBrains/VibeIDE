/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import React, { useState, useEffect, useCallback } from 'react';
import { ChatImageAttachment } from '../../../../common/chatThreadServiceTypes.js';
import { createImageDataUrl, revokeImageDataUrl, formatFileSize } from './imageUtils.js';
import { ImageLightbox } from './ImageLightbox.js';
import { attachmentsS } from '../vibe-settings-tsx/vibeSettingsRu.js';

export interface ImageMessageRendererProps {
	images: ChatImageAttachment[];
	caption?: string; // Optional text caption above images
}

/**
 * Renders images in a message with responsive grid layout
 * Supports click-to-zoom with lightbox
 */
export const ImageMessageRenderer: React.FC<ImageMessageRendererProps> = ({
	images,
	caption,
}) => {
	const [previewUrls, setPreviewUrls] = useState<Map<string, string>>(new Map());
	const [lightboxImageIndex, setLightboxImageIndex] = useState<number | null>(null);

	// Create preview URLs for all images
	useEffect(() => {
		const urls = new Map<string, string>();
		images.forEach(img => {
			const url = createImageDataUrl(img.data, img.mimeType);
			urls.set(img.id, url);
		});
		setPreviewUrls(urls);

		return () => {
			urls.forEach(url => revokeImageDataUrl(url));
		};
	}, [images]);

	const handleImageClick = useCallback((index: number) => {
		setLightboxImageIndex(index);
	}, []);

	const handleCloseLightbox = useCallback(() => {
		setLightboxImageIndex(null);
	}, []);

	const handleNavigate = useCallback((direction: 'prev' | 'next') => {
		if (lightboxImageIndex === null) {return;}
		if (direction === 'prev') {
			setLightboxImageIndex(Math.max(0, lightboxImageIndex - 1));
		} else {
			setLightboxImageIndex(Math.min(images.length - 1, lightboxImageIndex + 1));
		}
	}, [lightboxImageIndex, images.length]);

	if (images.length === 0) {
		return null;
	}

	// Determine grid layout: 1-up for 1, 2-up for 2-4, 3-up for 5+
	const gridCols = images.length === 1 ? 1 : images.length <= 4 ? 2 : 3;

	return (
		<>
			<div className="flex flex-col gap-2">
				{/* Caption text */}
				{caption && (
					<div className="text-vibe-fg-1 whitespace-pre-wrap break-words">
						{caption}
					</div>
				)}

				{/* Image grid */}
				<div
					className={`
						grid gap-2
						${gridCols === 1 ? 'grid-cols-1' : ''}
						${gridCols === 2 ? 'grid-cols-2' : ''}
						${gridCols === 3 ? 'grid-cols-3' : ''}
					`}
					role="group"
					aria-label={attachmentsS.imageGridAria(images.length)}
				>
					{images.map((img, index) => {
						const previewUrl = previewUrls.get(img.id);
						if (!previewUrl) {
							return (
								<div
									key={img.id}
									className="aspect-square bg-vibe-bg-2-alt rounded-md flex items-center justify-center"
								>
									<span className="text-vibe-fg-3 text-sm">{attachmentsS.loading}</span>
								</div>
							);
						}

						return (
							<div
								key={img.id}
								className="relative group cursor-pointer"
								role="button"
								tabIndex={0}
								onClick={() => handleImageClick(index)}
								onKeyDown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										handleImageClick(index);
									}
								}}
								aria-label={attachmentsS.imageClickToZoom(img.filename)}
							>
								<img
									src={previewUrl}
									alt={img.filename ? `${img.filename} (${img.width}×${img.height})` : attachmentsS.imageFallbackAlt(index + 1)}
									className={`
										w-full rounded-md
										object-cover
										transition-transform duration-200
										group-hover:scale-[1.02]
										${gridCols === 1 ? 'max-h-[320px] md:max-h-[400px]' : 'aspect-square max-h-[240px] md:max-h-[300px]'}
									`}
									loading="lazy"
								/>
								{/* Filename overlay on hover */}
								<div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-xs px-2 py-1 rounded-b-md opacity-0 group-hover:opacity-100 transition-opacity">
									<div className="truncate">{img.filename}</div>
									<div className="text-xs opacity-75">{formatFileSize(img.size)}</div>
								</div>
							</div>
						);
					})}
				</div>
			</div>

			{/* Lightbox */}
			{lightboxImageIndex !== null && (
				<ImageLightbox
					images={images}
					initialIndex={lightboxImageIndex}
					previewUrls={previewUrls}
					onClose={handleCloseLightbox}
					onNavigate={handleNavigate}
				/>
			)}
		</>
	);
};

