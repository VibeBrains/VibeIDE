/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import React, { useCallback } from 'react';
import { FileText, X, AlertCircle, Loader2 } from 'lucide-react';
import { ChatPDFAttachment } from '../../../../common/chatThreadServiceTypes.js';
import { attachmentsS } from '../vibe-settings-tsx/vibeSettingsRu.js';

const formatFileSize = (bytes: number): string => {
	if (bytes < 1024) {return `${bytes} B`;}
	if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export interface PDFAttachmentListProps {
	attachments: ChatPDFAttachment[];
	onRemove: (id: string) => void;
	onRetry?: (id: string) => void;
	onCancel?: (id: string) => void;
	focusedIndex: number | null;
	onFocusChange: (index: number | null) => void;
}

/**
 * List of PDF attachment chips
 */
export const PDFAttachmentList: React.FC<PDFAttachmentListProps> = ({
	attachments,
	onRemove,
	onRetry,
	onCancel,
	focusedIndex,
	onFocusChange,
}) => {
	const handleKeyDown = useCallback((e: React.KeyboardEvent, index: number) => {
		if (e.key === 'ArrowLeft' && index > 0) {
			e.preventDefault();
			onFocusChange(index - 1);
		} else if (e.key === 'ArrowRight' && index < attachments.length - 1) {
			e.preventDefault();
			onFocusChange(index + 1);
		}
	}, [attachments.length, onFocusChange]);

	if (attachments.length === 0) {
		return null;
	}

	return (
		<div
			className="flex flex-wrap gap-2 p-2 max-h-[300px] overflow-y-auto"
			role="list"
			aria-label={attachmentsS.listAria(attachments.length, 'pdf')}
		>
			{attachments.map((attachment, index) => {
				const isUploading = attachment.uploadStatus === 'uploading' || attachment.uploadStatus === 'processing';
				const isFailed = attachment.uploadStatus === 'failed';
				const isSuccess = attachment.uploadStatus === 'success' || !attachment.uploadStatus;
				const focused = focusedIndex === index;

				return (
					<div
						key={attachment.id}
						role="listitem"
						tabIndex={0}
						onKeyDown={(e) => {
							handleKeyDown(e, index);
							if (e.key === 'Delete' || e.key === 'Backspace') {
								e.preventDefault();
								onRemove(attachment.id);
							} else if (e.key === 'Enter' && isFailed && onRetry) {
								e.preventDefault();
								onRetry(attachment.id);
							}
						}}
						onFocus={() => onFocusChange(index)}
						className={`
							relative group
							flex flex-col
							w-[200px] min-h-[120px]
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
						{/* Preview area */}
						<div className="relative flex-1 w-full overflow-hidden bg-vibe-bg-1 flex items-center justify-center">
							{attachment.pagePreviews && attachment.pagePreviews.length > 0 ? (
								<img
									src={attachment.pagePreviews[0]}
									alt={attachmentsS.pageOf(attachment.filename)}
									className="w-full h-full object-contain"
									loading="lazy"
								/>
							) : (
								<FileText className="w-12 h-12 text-vibe-fg-3" />
							)}

							{/* Upload/processing overlay */}
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
													onCancel(attachment.id);
												}}
												className="text-xs text-white/80 hover:text-white underline mt-1"
												aria-label={attachmentsS.cancelProcessing}
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
									onRemove(attachment.id);
								}}
								aria-label={attachmentsS.removeAttachment(attachment.filename)}
								className="absolute top-1 right-1 p-1 rounded-md bg-black/60 hover:bg-black/80 text-white transition-opacity z-10 opacity-0 group-hover:opacity-100"
							>
								<X size={14} />
							</button>
						</div>

						{/* Info section */}
						<div className="px-2 py-1.5 bg-vibe-bg-2-alt border-t border-vibe-border-3">
							<div className="text-xs font-medium text-vibe-fg-1 truncate" title={attachment.filename}>
								{attachment.filename}
							</div>
							<div className="flex items-center justify-between mt-0.5">
								<div className="text-[10px] text-vibe-fg-3">
									{attachment.pageCount ? attachmentsS.pagesCount(attachment.pageCount) : formatFileSize(attachment.size)}
								</div>
								{isFailed && attachment.error && (
									<div className="text-[10px] text-red-500 truncate max-w-[120px]" title={attachment.error}>
										{attachment.error}
									</div>
								)}
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
};

