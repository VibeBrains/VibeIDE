/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Wall-clock timestamp for diagnostic trace lines ([VibeIDE/llmTurn], [VibeIDE/toolExec],
 * [VibeIDE/promptDump]). Format matches the chat UI checkpoint (DD.MM.YYYY HH:mm) but adds
 * seconds, so the silent gap *between* turns (provider thinking / idle) is visible in a
 * pasted console dump — DevTools "Show timestamps" is not copied with the text.
 *
 * Local time on purpose (same wall clock the chat shows). Manual padding keeps the format
 * locale-independent.
 */
import { vibeTimestamp } from '../../../../../base/common/vibeTimestamp.js';

export function vibeTraceTs(d: Date = new Date()): string {
	return vibeTimestamp(d);
}
