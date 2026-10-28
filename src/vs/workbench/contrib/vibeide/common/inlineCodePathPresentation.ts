/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';

export interface IInlineCodePathPresentation {
	/** Exactly what the agent wrote inside the backticks. */
	readonly displayText: string;
	/** Full/relative path for the hover, when the written text is an absolute path. */
	readonly tooltip: string | undefined;
}

/**
 * Inline code that looks like a local absolute path. The same heuristic the
 * chat renderer has always used to decide whether a codespan is a path worth
 * linking; common false positives are comments such as `//` and globs.
 */
export function isAbsoluteInlineCodePath(value: string): boolean {
	return value.length > 5 && isAbsolute(value) && !value.includes('//') && !value.includes('/*');
}

/**
 * Builds the visible label for an inline path in chat.
 *
 * The label is always the text the agent wrote. Earlier the renderer replaced
 * it with the basename of the resolved path, which hid the directory, and for
 * a folder path ending in `/` the basename was the empty string, so the whole
 * path disappeared. Resolving the path is still useful for the hover tooltip
 * and for click navigation, but it must not rewrite what the user sees.
 */
export function presentInlineCodePath(writtenText: string, resolveTooltip?: (uri: URI) => string | undefined): IInlineCodePathPresentation {
	const tooltip = isAbsoluteInlineCodePath(writtenText)
		? resolveTooltip?.(URI.file(writtenText))
		: undefined;

	return { displayText: writtenText, tooltip };
}
