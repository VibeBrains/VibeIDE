/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// L991-992 — Settings React panel that visualises the in-session
// `VibeSessionMemoryService` entries (per-thread short-term brain). The panel
// renders the recent entries for the currently-active chat thread; clearing
// here only releases the in-memory snapshot for that thread — the on-disk
// JSONL (.vibe/session-memory.jsonl) stays put.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useAccessor } from '../util/services.js';
import { safetyS } from './vibeSettingsRu.js';

interface MemoryRow {
	id: string;
	kind: string;
	updatedAt: number;
	content: string;
}

function formatAge(now: number, ts: number): string {
	const ms = Math.max(0, now - ts);
	const sec = Math.floor(ms / 1000);
	if (sec < 60) { return `${sec}s`; }
	const min = Math.floor(sec / 60);
	if (min < 60) { return `${min}m`; }
	const h = Math.floor(min / 60);
	if (h < 24) { return `${h}h`; }
	const d = Math.floor(h / 24);
	return `${d}d`;
}

export const MemoryPanel: React.FC = () => {
	const accessor = useAccessor();
	const [rows, setRows] = useState<MemoryRow[]>([]);
	const [loading, setLoading] = useState<boolean>(false);
	const [threadId, setThreadId] = useState<string | null>(null);

	const refresh = useCallback(() => {
		setLoading(true);
		try {
			const chatThreadService = accessor.get('IChatThreadService') as { getCurrentThread(): { id: string } | undefined };
			const memoryService = accessor.get('IVibeSessionMemoryService') as { getRecent(threadId: string, limit: number): MemoryRow[] };
			const current = chatThreadService.getCurrentThread();
			const id = current?.id ?? null;
			setThreadId(id);
			if (!id) {
				setRows([]);
				return;
			}
			const recent = memoryService.getRecent(id, 50);
			setRows(recent ?? []);
		} catch {
			setRows([]);
		} finally {
			setLoading(false);
		}
	}, [accessor]);

	useEffect(() => { refresh(); }, [refresh]);

	const clearLocal = useCallback(() => {
		if (!threadId) { return; }
		if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(safetyS.memoryPanelClearConfirm)) {
			return;
		}
		try {
			const memoryService = accessor.get('IVibeSessionMemoryService') as { releaseThread(threadId: string): void };
			memoryService.releaseThread(threadId);
		} catch { /* tolerated — no service present */ }
		refresh();
	}, [accessor, threadId, refresh]);

	const now = useMemo(() => Date.now(), [rows]);
	const empty = rows.length === 0;

	return (
		<div className='@@vibe-chat-like-shell overflow-hidden'>
			<div className='px-3 pt-3 pb-2 flex items-center gap-2'>
				<h3 className='text-lg font-semibold text-vibe-fg-1 flex-1'>{safetyS.memoryPanelTitle}</h3>
				<button
					type='button'
					className='px-2 py-1 text-sm bg-vibe-bg-3 hover:bg-vibe-bg-4 rounded-sm flex items-center gap-1'
					onClick={refresh}
					disabled={loading}
					aria-busy={loading}
				>
					<RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
					{safetyS.memoryPanelReload}
				</button>
				<button
					type='button'
					className='px-2 py-1 text-sm bg-vibe-bg-3 hover:bg-vibe-bg-4 rounded-sm flex items-center gap-1 text-vibe-warn'
					onClick={clearLocal}
					disabled={empty || !threadId}
				>
					<Trash2 size={14} />
					{safetyS.memoryPanelClear}
				</button>
			</div>
			<p className='px-3 text-sm text-vibe-fg-3'>{safetyS.memoryPanelIntro}</p>
			{empty ? (
				<p className='px-3 pb-3 pt-2 text-sm text-vibe-fg-4 italic'>{safetyS.memoryPanelEmpty}</p>
			) : (
				<table className='w-full text-sm mt-2'>
					<thead>
						<tr className='text-left text-vibe-fg-3'>
							<th className='px-3 py-1'>{safetyS.memoryPanelColKind}</th>
							<th className='px-3 py-1'>{safetyS.memoryPanelColAge}</th>
							<th className='px-3 py-1'>{safetyS.memoryPanelColPreview}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map(r => (
							<tr key={r.id} className='border-t border-vibe-border-4 align-top'>
								<td className='px-3 py-1 font-mono whitespace-nowrap'>{r.kind}</td>
								<td className='px-3 py-1 whitespace-nowrap text-vibe-fg-3'>{formatAge(now, r.updatedAt)}</td>
								<td className='px-3 py-1 text-vibe-fg-1'>
									<span className='line-clamp-3'>{r.content}</span>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<p className='px-3 pb-3 pt-2 text-xs text-vibe-fg-4'>{safetyS.memoryPanelDocsLink}</p>
		</div>
	);
};

export default MemoryPanel;
