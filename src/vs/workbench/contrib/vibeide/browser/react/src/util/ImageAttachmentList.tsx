/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useState, useCallback } from 'react';
import { ImageAttachmentChip } from './ImageAttachmentChip.js';
import { ChatImageAttachment } from '../../../../common/chatThreadServiceTypes.js';

export interface ImageAttachmentListProps {
	attachments: ChatImageAttachment[];
	onRemove: (id: string) => void;
	onRetry?: (id: string) => void;
	onCancel?: (id: string) => void;
	focusedIndex: number | null;
	onFocusChange: (index: number | null) => void;
}

/**
 * List of image attachment chips with keyboard navigation
 */
export const ImageAttachmentList: React.FC<ImageAttachmentListProps> = ({
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
			aria-label={`${attachments.length} image attachment${attachments.length !== 1 ? 's' : ''}`}
		>
			{attachments.map((attachment, index) => (
				<div
					key={attachment.id}
					role="listitem"
					onKeyDown={(e) => handleKeyDown(e, index)}
				>
					<ImageAttachmentChip
						attachment={attachment}
						onRemove={() => onRemove(attachment.id)}
						onRetry={onRetry ? () => onRetry(attachment.id) : undefined}
						onCancel={onCancel ? () => onCancel(attachment.id) : undefined}
						index={index}
						focused={focusedIndex === index}
						onFocus={() => onFocusChange(index)}
					/>
				</div>
			))}
		</div>
	);
};

