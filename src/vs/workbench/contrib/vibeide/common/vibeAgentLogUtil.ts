/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/** Local wall-clock prefix for agent activity logs (nginx access-log style). */
export function formatVibeAgentLogPrefix(date: Date = new Date()): string {
	const y = date.getFullYear();
	const mo = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	const h = String(date.getHours()).padStart(2, '0');
	const mi = String(date.getMinutes()).padStart(2, '0');
	const s = String(date.getSeconds()).padStart(2, '0');
	return `[${y}-${mo}-${d} ${h}:${mi}:${s}]`;
}

export function formatVibeAgentLogLine(kind: 'Started' | 'Finished' | 'Error', message: string, date?: Date): string {
	return `${formatVibeAgentLogPrefix(date)} ${kind}: ${message}`;
}
