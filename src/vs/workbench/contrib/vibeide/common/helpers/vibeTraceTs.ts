/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Wall-clock timestamp for diagnostic trace lines ([VibeIDE/llmTurn], [VibeIDE/toolExec],
 * [VibeIDE/promptDump]). Format matches the chat UI checkpoint (DD.MM.YYYY HH:mm) but adds
 * seconds, so the silent gap *between* turns (provider thinking / idle) is visible in a
 * pasted console dump — DevTools "Show timestamps" is not copied with the text.
 *
 * Local time on purpose (same wall clock the chat shows). Manual padding keeps the format
 * locale-independent.
 */
export function vibeTraceTs(d: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
