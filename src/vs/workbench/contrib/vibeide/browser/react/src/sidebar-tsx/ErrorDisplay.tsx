/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import React, { useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp, X, RotateCcw, RefreshCw, FileText } from 'lucide-react';
import { useSettingsState } from '../util/services.js';
import { errorDetails } from '../../../../common/sendLLMMessageTypes.js';
import { toErrorMessage } from '../../../../../../../base/common/errorMessage.js';
import { errorDisplayS } from '../vibe-settings-tsx/vibeSettingsRu.js';


export const ErrorDisplay = ({
	message: message_,
	fullError,
	onDismiss,
	showDismiss,
	onRetry,
	onRollback,
	onOpenLogs,
}: {
	message: string;
	fullError: Error | null;
	onDismiss: (() => void) | null;
	showDismiss?: boolean;
	onRetry?: (() => void) | null;
	onRollback?: (() => void) | null;
	onOpenLogs?: (() => void) | null;
}) => {
	const [isExpanded, setIsExpanded] = useState(false);

	// Normalize error message - prefer the provided message, fall back to extracting from error object
	// This ensures user-friendly messages (like rate limit errors) are shown correctly
	let normalizedMessage: string;
	if (message_ && message_.trim()) {
		// Use the provided message if it exists and is not empty
		normalizedMessage = message_;
	} else if (fullError) {
		// Fall back to extracting message from error object
		normalizedMessage = toErrorMessage(fullError, false);
	} else {
		// Last resort: generic error message
		normalizedMessage = errorDisplayS.unknown;
	}

	// Only show details in dev mode or when explicitly expanded (never show raw stacks)
	const details = isExpanded && fullError ? errorDetails(fullError) : null;
	const isExpandable = !!fullError && (fullError.stack || (fullError.message && fullError.message !== normalizedMessage));

	const message = normalizedMessage + '';

	return (
		<div className={`rounded-lg border border-red-200 bg-red-50 p-4 overflow-auto error-display-enter shadow-sm`}>
			{/* Header */}
			<div className='flex items-start justify-between gap-3'>
				<div className='flex gap-3 flex-1 min-w-0'>
					<AlertCircle className='h-5 w-5 text-red-600 mt-0.5 flex-shrink-0' />
					<div className='flex-1 min-w-0'>
						<h3 className='font-semibold text-red-800 text-sm'>
							{errorDisplayS.header}
						</h3>
						<p className='text-red-700 mt-1 text-sm break-words'>
							{/* eg Something went wrong */}
							{message}
						</p>
					</div>
				</div>

				<div className='flex gap-1 flex-shrink-0'>
					{isExpandable && (
						<button
							className='text-red-600 hover:text-red-800 hover:bg-red-100 p-1.5 rounded transition-colors duration-200'
							onClick={() => setIsExpanded(!isExpanded)}
							aria-label={isExpanded ? errorDisplayS.hideDetails : errorDisplayS.showDetails}
							aria-expanded={isExpanded}
						>
							{isExpanded ? (
								<ChevronUp className='h-4 w-4' />
							) : (
								<ChevronDown className='h-4 w-4' />
							)}
						</button>
					)}
					{showDismiss && onDismiss && (
						<button
							className='text-red-600 hover:text-red-800 hover:bg-red-100 p-1.5 rounded transition-colors duration-200'
							onClick={onDismiss}
							aria-label={errorDisplayS.dismissAria}
						>
							<X className='h-4 w-4' />
						</button>
					)}
				</div>
			</div>

			{/* Action Buttons */}
			{(onRetry || onRollback || onOpenLogs) && (
				<div className='mt-3 flex gap-2 flex-wrap'>
					{onRetry && (
						<button
							type="button"
							className='@@vibe-pill-button @@vibe-pill-button--primary @@vibe-focus-ring flex items-center gap-1.5 text-sm'
							onClick={onRetry}
							aria-label={errorDisplayS.retryAria}
						>
							<RefreshCw className='h-4 w-4' />
							{errorDisplayS.retryLabel}
						</button>
					)}
					{onRollback && (
						<button
							type="button"
							className='@@vibe-pill-button @@vibe-pill-button--secondary @@vibe-focus-ring flex items-center gap-1.5 text-sm'
							onClick={onRollback}
							aria-label={errorDisplayS.rollbackAria}
						>
							<RotateCcw className='h-4 w-4' />
							{errorDisplayS.rollbackLabel}
						</button>
					)}
					{onOpenLogs && (
						<button
							type="button"
							className='@@vibe-pill-button @@vibe-focus-ring flex items-center gap-1.5 text-sm'
							onClick={onOpenLogs}
							aria-label={errorDisplayS.openLogsAria}
						>
							<FileText className='h-4 w-4' />
							{errorDisplayS.openLogsLabel}
						</button>
					)}
				</div>
			)}

			{/* Expandable Details (dev mode only, no raw stacks) */}
			{isExpanded && details && (
				<div className='mt-4 space-y-3 border-t border-red-200 pt-3 overflow-auto animate-in fade-in slide-in-from-top-2 duration-200'>
					<div>
						<span className='font-semibold text-red-800 text-xs'>{errorDisplayS.technicalDetails}</span>
						<pre className='text-red-700 text-xs mt-1.5 p-2 bg-red-100/50 rounded border border-red-200/50 overflow-x-auto'>{details}</pre>
					</div>
				</div>
			)}
		</div>
	);
};
