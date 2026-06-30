/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import React, { useEffect, useRef, useState } from 'react';
import { X, AlertCircle, Loader2 } from 'lucide-react';
import { ChatImageAttachment } from '../../../../common/chatThreadServiceTypes.js';
import { createImageDataUrl, revokeImageDataUrl, formatFileSize } from './imageUtils.js';
import { attachmentsS } from '../vibe-settings-tsx/vibeSettingsRu.js';

export interface ImageAttachmentChipProps {
	attachment: ChatImageAttachment;
	onRemove: () => void;
	onRetry?: () => void;
	onCancel?: () => void;
	index: number;
	focused: boolean;
	onFocus: () => void;
}

/**
 * Image attachment chip for the composer
 * Shows thumbnail, filename, size, and status with remove button
 */
export const ImageAttachmentChip: React.FC<ImageAttachmentChipProps> = ({
	attachment,
	onRemove,
	onRetry,
	onCancel,
	index,
	focused,
	onFocus,
}) => {
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const chipRef = useRef<HTMLDivElement>(null);

	// Create preview URL from image data
	useEffect(() => {
		const url = createImageDataUrl(attachment.data, attachment.mimeType);
		setPreviewUrl(url);
		return () => {
			if (url) {
				revokeImageDataUrl(url);
			}
		};
	}, [attachment.data, attachment.mimeType]);

	// Focus management
	useEffect(() => {
		if (focused && chipRef.current) {
			chipRef.current.focus();
		}
	}, [focused]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Delete' || e.key === 'Backspace') {
			e.preventDefault();
			onRemove();
		} else if (e.key === 'Enter' && attachment.uploadStatus === 'failed' && onRetry) {
			e.preventDefault();
			onRetry();
		}
	};

	const isUploading = attachment.uploadStatus === 'uploading';
	const isFailed = attachment.uploadStatus === 'failed';
	const isSuccess = attachment.uploadStatus === 'success' || !attachment.uploadStatus;

		return (
		<div
			ref={chipRef}
			role="button"
			tabIndex={0}
			aria-label={attachmentsS.imageAttachmentAria(attachment.filename, formatFileSize(attachment.size), isUploading ? 'uploading' : isFailed ? 'failed' : 'ready')}
			onFocus={onFocus}
			onKeyDown={handleKeyDown}
			className={`
				relative group
				flex flex-col
				w-[160px] h-[120px]
				rounded-md
				border border-vibe-border-3
				bg-vibe-bg-2-alt
				overflow-hidden
				cursor-pointer
				transition-all duration-200
				${focused ? 'ring-2 ring-blue-500 border-blue-500' : 'hover:border-vibe-border-1'}
				${isFailed ? 'border-red-500' : ''}
			`}
		>
			{/* Thumbnail */}
			<div className="relative flex-1 w-full overflow-hidden bg-vibe-bg-1">
				{previewUrl ? (
					<img
						src={previewUrl}
						alt={attachment.filename}
						className="w-full h-full object-cover"
						loading="lazy"
					/>
				) : (
					<div className="w-full h-full flex items-center justify-center text-vibe-fg-3">
						<Loader2 className="w-6 h-6 animate-spin" />
					</div>
				)}

				{/* Upload progress overlay */}
				{isUploading && (
					<div className="absolute inset-0 bg-black/50 flex items-center justify-center">
						<div className="flex flex-col items-center gap-2">
							<Loader2 className="w-5 h-5 text-white animate-spin" />
							{attachment.uploadProgress !== undefined ? (
								<div className="text-xs text-white">
									{Math.round(attachment.uploadProgress * 100)}%
								</div>
							) : (
								<div className="text-xs text-white">{attachmentsS.processing}</div>
							)}
							{onCancel && (
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										onCancel();
									}}
									className="text-xs text-white/80 hover:text-white underline mt-1"
									aria-label={attachmentsS.cancelUpload}
								>
									{attachmentsS.cancel}
								</button>
							)}
						</div>
					</div>
				)}

				{/* Failed state overlay */}
				{isFailed && (
					<div className="absolute inset-0 bg-red-500/20 flex items-center justify-center">
						<AlertCircle className="w-5 h-5 text-red-500" />
					</div>
				)}

				{/* Remove button */}
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					aria-label={attachmentsS.removeAttachment(attachment.filename)}
					className="absolute top-1 right-1 p-1 rounded-md bg-black/60 hover:bg-black/80 text-white transition-opacity z-10"
					onMouseEnter={(e) => {
						e.currentTarget.style.opacity = '1';
					}}
					onMouseLeave={(e) => {
						if (!isFailed && !isUploading) {
							e.currentTarget.style.opacity = '0.7';
						}
					}}
					style={{ opacity: isFailed || isUploading ? 1 : 0.7 }}
				>
					<X size={14} />
				</button>
			</div>

			{/* Filename and size */}
			<div className="px-2 py-1 bg-vibe-bg-2-alt border-t border-vibe-border-3">
				<div className="text-xs text-vibe-fg-1 truncate" title={attachment.filename}>
					{attachment.filename}
				</div>
				<div className="text-xs text-vibe-fg-3">
					{formatFileSize(attachment.size)}
				</div>
			</div>

			{/* Error message */}
			{isFailed && attachment.error && (
				<div className="px-2 py-1 bg-red-500/10 border-t border-red-500">
					<div className="text-xs text-red-500 truncate" title={attachment.error}>
						{attachment.error}
					</div>
					{onRetry && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onRetry();
							}}
							className="text-xs text-blue-500 hover:text-blue-400 mt-1"
						>
							{attachmentsS.retry}
						</button>
					)}
				</div>
			)}

			{/* Progress bar */}
			{isUploading && attachment.uploadProgress !== undefined && (
				<div className="absolute bottom-0 left-0 right-0 h-1 bg-vibe-bg-1">
					<div
						className="h-full bg-blue-500 transition-all duration-300"
						style={{ width: `${attachment.uploadProgress * 100}%` }}
					/>
				</div>
			)}
		</div>
	);
};

