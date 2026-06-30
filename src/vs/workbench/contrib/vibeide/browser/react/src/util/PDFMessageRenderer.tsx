/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import React from 'react';
import { ChatPDFAttachment } from '../../../../common/chatThreadServiceTypes.js';
import { FileText } from 'lucide-react';
import { attachmentsS } from '../vibe-settings-tsx/vibeSettingsRu.js';

const formatFileSize = (bytes: number): string => {
	if (bytes < 1024) {return `${bytes} B`;}
	if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export interface PDFMessageRendererProps {
	pdfs: ChatPDFAttachment[];
	caption?: string; // Optional text caption above PDFs
}

/**
 * Renders PDFs in a message with responsive grid layout
 * Shows PDF previews and metadata
 */
export const PDFMessageRenderer: React.FC<PDFMessageRendererProps> = ({
	pdfs,
	caption,
}) => {
	if (pdfs.length === 0) {
		return null;
	}

	// Determine grid layout: 1-up for 1, 2-up for 2-4, 3-up for 5+
	const gridCols = pdfs.length === 1 ? 1 : pdfs.length <= 4 ? 2 : 3;

	return (
		<div className="flex flex-col gap-2">
			{/* Caption text */}
			{caption && (
				<div className="text-vibe-fg-1 whitespace-pre-wrap break-words">
					{caption}
				</div>
			)}

			{/* PDF grid */}
			<div
				className={`
					grid gap-2
					${gridCols === 1 ? 'grid-cols-1' : ''}
					${gridCols === 2 ? 'grid-cols-2' : ''}
					${gridCols === 3 ? 'grid-cols-3' : ''}
				`}
				role="group"
				aria-label={attachmentsS.pdfGridAria(pdfs.length)}
			>
				{pdfs.map((pdf, index) => {
					const hasPreview = pdf.pagePreviews && pdf.pagePreviews.length > 0;

					return (
						<div
							key={pdf.id}
							className="relative group"
							role="button"
							tabIndex={0}
							aria-label={attachmentsS.pdfAria(pdf.filename)}
						>
							<div
								className={`
									relative
									bg-vibe-bg-2-alt
									border border-vibe-border-3
									rounded-md
									overflow-hidden
									transition-all duration-200
									group-hover:border-vibe-border-1
									${gridCols === 1 ? 'max-h-[320px] md:max-h-[400px]' : 'aspect-[3/4] max-h-[240px] md:max-h-[300px]'}
								`}
							>
								{/* Preview area */}
								<div className="w-full h-full flex items-center justify-center bg-vibe-bg-1">
									{hasPreview ? (
										<img
											src={pdf.pagePreviews![0]}
											alt={attachmentsS.pageOf(pdf.filename)}
											className="w-full h-full object-contain"
											loading="lazy"
										/>
									) : (
										<FileText className="w-12 h-12 text-vibe-fg-3" />
									)}
								</div>

								{/* Info overlay on hover */}
								<div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-xs px-2 py-1.5 rounded-b-md opacity-0 group-hover:opacity-100 transition-opacity">
									<div className="truncate font-medium">{pdf.filename}</div>
									<div className="flex items-center justify-between mt-0.5">
										<div className="text-[10px] opacity-75">
											{pdf.pageCount
												? attachmentsS.pagesCount(pdf.pageCount)
												: formatFileSize(pdf.size)}
										</div>
										{hasPreview && pdf.pagePreviews!.length > 1 && (
											<div className="text-[10px] opacity-75">
												{attachmentsS.morePages(pdf.pagePreviews!.length - 1)}
											</div>
										)}
									</div>
								</div>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
};

