/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wall-clock "DD.MM.YYYY HH:mm:ss" stamp shared by every VibeIDE log surface
 * (renderer ConsoleLogger, the web-worker console wrapper, vibeTraceTs). Lives in
 * the lowest layer with ZERO imports so it can be pulled into worker bundles
 * without dragging in nls/platform. Local time, manual padding -> locale-independent.
 */
export function vibeTimestamp(d: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
