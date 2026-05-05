/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { ChatImageAttachment } from '../../../../common/chatThreadServiceTypes.js';
import { formatFileSize } from './imageUtils.js';

export interface ImageLightboxProps {
	images: ChatImageAttachment[];
	initialIndex: number;
	previewUrls: Map<string, string>;
	onClose: () => void;
	onNavigate: (direction: 'prev' | 'next') => void;
}

/**
 * Lightbox component for viewing images in full screen
 * Supports keyboard navigation, pinch zoom, pan, and ESC to close
 */
export const ImageLightbox: React.FC<ImageLightboxProps> = ({
	images,
	initialIndex,
	previewUrls,
	onClose,
	onNavigate,
}) => {
	const [currentIndex, setCurrentIndex] = useState(initialIndex);
	const [scale, setScale] = useState(1);
	const [position, setPosition] = useState({ x: 0, y: 0 });
	const [isDragging, setIsDragging] = useState(false);
	const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
	const [lastTouchDistance, setLastTouchDistance] = useState<number | null>(null);
	const [lastTouchCenter, setLastTouchCenter] = useState<{ x: number; y: number } | null>(null);
	const imageRef = useRef<HTMLImageElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const previousFocusRef = useRef<HTMLElement | null>(null);

	const currentImage = images[currentIndex];
	const currentUrl = currentImage ? previewUrls.get(currentImage.id) : null;

	// Update current index when initialIndex changes
	useEffect(() => {
		setCurrentIndex(initialIndex);
		setScale(1);
		setPosition({ x: 0, y: 0 });
	}, [initialIndex]);

	// Keyboard navigation
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose();
			} else if (e.key === 'ArrowLeft') {
				e.preventDefault();
				onNavigate('prev');
				setCurrentIndex(prev => Math.max(0, prev - 1));
			} else if (e.key === 'ArrowRight') {
				e.preventDefault();
				onNavigate('next');
				setCurrentIndex(prev => Math.min(images.length - 1, prev + 1));
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => {
			window.removeEventListener('keydown', handleKeyDown);
		};
	}, [images.length, onClose, onNavigate]);

	// Focus trap - store previous focus and restore on close
	useEffect(() => {
		if (containerRef.current) {
			// Store the previously focused element
			previousFocusRef.current = document.activeElement as HTMLElement;
			containerRef.current.focus();
		}
		return () => {
			// Restore focus when closing
			if (previousFocusRef.current) {
				previousFocusRef.current.focus();
			}
		};
	}, []);

	const handleWheel = useCallback((e: React.WheelEvent) => {
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			const delta = e.deltaY > 0 ? 0.9 : 1.1;
			setScale(prev => Math.max(0.5, Math.min(5, prev * delta)));
		}
	}, []);

	const handleMouseDown = useCallback((e: React.MouseEvent) => {
		if (e.button === 0 && scale > 1) { // Left click and zoomed in
			setIsDragging(true);
			setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
		}
	}, [scale, position]);

	const handleMouseMove = useCallback((e: React.MouseEvent) => {
		if (isDragging) {
			setPosition({
				x: e.clientX - dragStart.x,
				y: e.clientY - dragStart.y,
			});
		}
	}, [isDragging, dragStart]);

	const handleMouseUp = useCallback(() => {
		setIsDragging(false);
	}, []);

	const handleDoubleClick = useCallback(() => {
		if (scale > 1) {
			setScale(1);
			setPosition({ x: 0, y: 0 });
		} else {
			setScale(2);
		}
	}, [scale]);

	const handlePrev = useCallback(() => {
		if (currentIndex > 0) {
			setCurrentIndex(currentIndex - 1);
			setScale(1);
			setPosition({ x: 0, y: 0 });
		}
	}, [currentIndex]);

	const handleNext = useCallback(() => {
		if (currentIndex < images.length - 1) {
			setCurrentIndex(currentIndex + 1);
			setScale(1);
			setPosition({ x: 0, y: 0 });
		}
	}, [currentIndex, images.length]);

	// Touch handlers for pinch zoom and pan
	const handleTouchStart = useCallback((e: React.TouchEvent) => {
		if (e.touches.length === 2) {
			// Pinch zoom
			const touch1 = e.touches[0];
			const touch2 = e.touches[1];
			const distance = Math.hypot(
				touch2.clientX - touch1.clientX,
				touch2.clientY - touch1.clientY
			);
			setLastTouchDistance(distance);
			setLastTouchCenter({
				x: (touch1.clientX + touch2.clientX) / 2,
				y: (touch1.clientY + touch2.clientY) / 2,
			});
		} else if (e.touches.length === 1 && scale > 1) {
			// Single touch pan when zoomed
			const touch = e.touches[0];
			setIsDragging(true);
			setDragStart({ x: touch.clientX - position.x, y: touch.clientY - position.y });
		}
	}, [scale, position]);

	const handleTouchMove = useCallback((e: React.TouchEvent) => {
		e.preventDefault();
		if (e.touches.length === 2 && lastTouchDistance !== null && lastTouchCenter) {
			// Pinch zoom
			const touch1 = e.touches[0];
			const touch2 = e.touches[1];
			const distance = Math.hypot(
				touch2.clientX - touch1.clientX,
				touch2.clientY - touch1.clientY
			);
			const scaleFactor = distance / lastTouchDistance;
			setScale(prev => Math.max(0.5, Math.min(5, prev * scaleFactor)));
			setLastTouchDistance(distance);

			// Adjust position to keep center point fixed
			const newCenter = {
				x: (touch1.clientX + touch2.clientX) / 2,
				y: (touch1.clientY + touch2.clientY) / 2,
			};
			const centerDelta = {
				x: newCenter.x - lastTouchCenter.x,
				y: newCenter.y - lastTouchCenter.y,
			};
			setPosition(prev => ({
				x: prev.x + centerDelta.x,
				y: prev.y + centerDelta.y,
			}));
			setLastTouchCenter(newCenter);
		} else if (e.touches.length === 1 && isDragging) {
			// Single touch pan
			const touch = e.touches[0];
			setPosition({
				x: touch.clientX - dragStart.x,
				y: touch.clientY - dragStart.y,
			});
		}
	}, [lastTouchDistance, lastTouchCenter, isDragging, dragStart]);

	const handleTouchEnd = useCallback(() => {
		setLastTouchDistance(null);
		setLastTouchCenter(null);
		setIsDragging(false);
	}, []);

	if (!currentImage || !currentUrl) {
		return null;
	}

	return (
		<div
			ref={containerRef}
			role="dialog"
			aria-modal="true"
			aria-label={`Image ${currentIndex + 1} of ${images.length}: ${currentImage.filename}`}
			tabIndex={-1}
			className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center"
			onClick={(e) => {
				if (e.target === e.currentTarget) {
					onClose();
				}
			}}
			onKeyDown={(e) => {
				if (e.key === 'Escape') {
					onClose();
				}
			}}
		>
			{/* Close button */}
			<button
				type="button"
				onClick={onClose}
				className="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/60 hover:bg-black/80 text-white transition-colors"
				aria-label="Close lightbox"
			>
				<X size={24} />
			</button>

			{/* Previous button */}
			{currentIndex > 0 && (
				<button
					type="button"
					onClick={handlePrev}
					className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/60 hover:bg-black/80 text-white transition-colors"
					aria-label="Previous image"
				>
					<ChevronLeft size={24} />
				</button>
			)}

			{/* Next button */}
			{currentIndex < images.length - 1 && (
				<button
					type="button"
					onClick={handleNext}
					className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/60 hover:bg-black/80 text-white transition-colors"
					aria-label="Next image"
				>
					<ChevronRight size={24} />
				</button>
			)}

			{/* Image container */}
			<div
				className="relative w-full h-full flex items-center justify-center overflow-hidden touch-none"
				onWheel={handleWheel}
				onMouseDown={handleMouseDown}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				onMouseLeave={handleMouseUp}
				onTouchStart={handleTouchStart}
				onTouchMove={handleTouchMove}
				onTouchEnd={handleTouchEnd}
			>
				<img
					ref={imageRef}
					src={currentUrl}
					alt={currentImage.filename || `Image ${currentIndex + 1}`}
					onDoubleClick={handleDoubleClick}
					className="max-w-full max-h-full object-contain transition-transform duration-200"
					style={{
						transform: `scale(${scale}) translate(${position.x}px, ${position.y}px)`,
						cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in',
					}}
					draggable={false}
				/>
			</div>

			{/* Image info */}
			<div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 text-white px-4 py-2 rounded-md text-sm">
				<div className="font-medium">{currentImage.filename}</div>
				<div className="text-xs opacity-75">
					{currentImage.width} × {currentImage.height} • {formatFileSize(currentImage.size)}
					{images.length > 1 && ` • ${currentIndex + 1} of ${images.length}`}
				</div>
			</div>

			{/* Navigation dots for multiple images */}
			{images.length > 1 && (
				<div className="absolute bottom-16 left-1/2 -translate-x-1/2 flex gap-2">
					{images.map((_, index) => (
						<button
							key={index}
							type="button"
							onClick={() => {
								setCurrentIndex(index);
								setScale(1);
								setPosition({ x: 0, y: 0 });
							}}
							className={`
								w-2 h-2 rounded-full transition-all
								${index === currentIndex ? 'bg-white' : 'bg-white/40'}
								hover:bg-white/60
							`}
							aria-label={`Go to image ${index + 1}`}
						/>
					))}
				</div>
			)}
		</div>
	);
};

