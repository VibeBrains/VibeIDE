/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { useState, useEffect, useRef, useCallback } from 'react';
import { useIsDark, useAccessor, useChatThreadsState } from '../util/services.js';
import { X as IconClose, Plus as IconPlus, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { StorageScope, StorageTarget } from '../../../../../../../platform/storage/common/storage.js';
import { Parts } from '../../../../../../../workbench/services/layout/browser/layoutService.js';
import { chatS } from '../vibe-settings-tsx/vibeSettingsRu.js';
import { trackRenderLoop } from '../util/renderLoopGuard.js';

import '../styles.css';
import { SidebarChat } from './SidebarChat.js';
import { SidebarHistory } from './SidebarHistory.js';
import ErrorBoundary from './ErrorBoundary.js';

// History rail width (px). The chat keeps its width; opening/closing the rail grows/shrinks the
// whole auxiliary bar by this amount (chat stays put). The bar's one-time default width is
// `vibeide.chat.defaultWidth` (650px), so the chat starts at ~650px with the rail collapsed.
const HISTORY_RAIL_WIDTH_PX = 280;
// When the CHAT column itself (not the whole bar) is squeezed narrower than this while the rail is
// open, auto-collapse the rail (no bar resize — the user is dragging the bar border).
const CHAT_MIN_WIDTH_PX = 370;
const HISTORY_COLLAPSED_KEY = 'vibeide.chatHistoryRailCollapsed';
// One-time flag: the configured default bar width has been applied (so we don't clobber the
// user's later manual resize, which the workbench persists on its own).
const DEFAULT_WIDTH_APPLIED_KEY = 'vibeide.chatDefaultWidthApplied';

// Multi-chat tab strip (refactor B): the in-view replacement for the old editor tabs. Renders the
// service's `openTabIds` working set; click switches, X closes (thread stays in history), + opens new.
// Also hosts the history rail collapse/expand toggle (right-aligned) so it's reachable in both states.
const tabLabel = (thread: { messages?: ReadonlyArray<{ role: string; displayContent?: string; content?: string }> } | undefined): string => {
	const firstUser = thread?.messages?.find(m => m.role === 'user');
	const txt = ((firstUser?.displayContent || firstUser?.content || '') as string).trim();
	if (!txt) { return chatS.chatTabUntitled; }
	return txt.length > 22 ? txt.slice(0, 22) + '…' : txt;
};

const ChatTabStrip = ({ historyCollapsed, onToggleHistory }: { historyCollapsed: boolean; onToggleHistory: () => void }) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const state = useChatThreadsState();
	const openTabIds: string[] = state.openTabIds ?? [];
	const current = state.currentThreadId;
	// Drag-and-drop reordering state: the tab being dragged + the tab currently hovered as drop target.
	const [dragId, setDragId] = useState<string | null>(null);
	const [overId, setOverId] = useState<string | null>(null);
	return (
		<div className="h-[34px] flex items-center gap-1 px-1 border-b border-vibe-border-1 overflow-x-auto flex-shrink-0 bg-vibe-bg-2">
			{openTabIds.map(id => {
				const thread = state.allThreads[id];
				const active = id === current;
				const label = tabLabel(thread);
				const isDragging = dragId === id;
				const isDropTarget = !!dragId && dragId !== id && overId === id;
				return (
					<div
						key={id}
						draggable
						onDragStart={(e) => { setDragId(id); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', id); } catch { /* some platforms reject setData */ } }}
						onDragOver={(e) => { if (dragId && dragId !== id) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overId !== id) { setOverId(id); } } }}
						onDragLeave={() => { if (overId === id) { setOverId(null); } }}
						onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== id) { chatThreadsService.reorderOpenTabs(dragId, id); } setDragId(null); setOverId(null); }}
						onDragEnd={() => { setDragId(null); setOverId(null); }}
						onClick={() => chatThreadsService.switchToThread(id)}
						title={label}
						className={`group flex items-center gap-1 px-2 py-1 rounded-t text-xs cursor-pointer whitespace-nowrap max-w-[160px] border-b-2 transition-opacity ${isDragging ? 'opacity-40' : ''} ${isDropTarget ? 'border-l-2 border-l-blue-400 bg-vibe-bg-3' : 'border-l-2 border-l-transparent'} ${active
							? 'bg-vibe-bg-1 text-vibe-fg-1 font-medium border-blue-400'
							: 'text-vibe-fg-3 border-transparent hover:bg-vibe-bg-3 hover:text-vibe-fg-2'}`}
					>
						<span className="truncate">{label}</span>
						{openTabIds.length > 1 && (
							<button
								type="button"
								className="opacity-0 group-hover:opacity-100 hover:text-vibe-fg-1 shrink-0"
								title={chatS.chatTabCloseTooltip}
								onClick={(e) => { e.stopPropagation(); chatThreadsService.closeTab(id); }}
							><IconClose size={11} /></button>
						)}
					</div>
				);
			})}
			<button
				type="button"
				className="shrink-0 px-1 py-0.5 rounded text-vibe-fg-3 hover:text-vibe-fg-1 hover:bg-vibe-bg-3"
				title={chatS.chatTabNewTooltip}
				onClick={() => chatThreadsService.forceCreateNewThread()}
			><IconPlus size={13} /></button>
			{/* History rail toggle — pushed to the right edge of the strip. */}
			<button
				type="button"
				className="shrink-0 ml-auto px-1 py-0.5 rounded text-vibe-fg-3 hover:text-vibe-fg-1 hover:bg-vibe-bg-3"
				title={historyCollapsed ? chatS.historyExpandTooltip : chatS.historyCollapseTooltip}
				onClick={onToggleHistory}
			>{historyCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}</button>
		</div>
	);
};

// Two-column chat surface (refactor B): chat fills the left, a collapsible right rail holds the history
// list (header "История"). The session/context token counter is pinned to a full-width footer below
// both columns so collapsing the history rail never hides it. All inside ONE auxiliary-bar View — no
// editor group to merge/strand. The auxiliary bar itself is resizable.
export const Sidebar = ({ className }: { className: string }) => {
	trackRenderLoop('Sidebar');

	const isDark = useIsDark();
	const accessor = useAccessor();
	const storageService = accessor.get('IStorageService');
	const layoutService = accessor.get('IWorkbenchLayoutService');
	const configurationService = accessor.get('IConfigurationService');
	// Re-key the chat by active thread so switching tabs fully re-renders it for the new thread.
	const { currentThreadId } = useChatThreadsState();

	const chatColRef = useRef<HTMLDivElement>(null);
	const [historyCollapsed, setHistoryCollapsed] = useState<boolean>(() => storageService.getBoolean(HISTORY_COLLAPSED_KEY, StorageScope.PROFILE, true));

	const setAuxBarWidth = useCallback((width: number) => {
		const cur = layoutService.getSize(Parts.AUXILIARYBAR_PART);
		layoutService.setSize(Parts.AUXILIARYBAR_PART, { width: Math.max(320, Math.round(width)), height: cur.height });
	}, [layoutService]);

	// Apply the configured default bar width ONCE so the chat starts at ~650px. Afterwards the
	// workbench persists the user's own width and we never override it.
	useEffect(() => {
		if (storageService.getBoolean(DEFAULT_WIDTH_APPLIED_KEY, StorageScope.PROFILE, false)) { return; }
		const chatW = Math.max(320, Math.min(2000, Math.floor(configurationService.getValue<number>('vibeide.chat.defaultWidth') ?? 650)));
		setAuxBarWidth(chatW + (historyCollapsed ? 0 : HISTORY_RAIL_WIDTH_PX));
		storageService.store(DEFAULT_WIDTH_APPLIED_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
		// Intentionally run once on mount: applies the default width a single time, then never again.
	}, []);

	// Button toggle: grow/shrink the bar by the rail width so the chat column keeps its width.
	const toggleHistory = useCallback(() => {
		const next = !historyCollapsed;
		setHistoryCollapsed(next);
		storageService.store(HISTORY_COLLAPSED_KEY, next, StorageScope.PROFILE, StorageTarget.USER);
		const cur = layoutService.getSize(Parts.AUXILIARYBAR_PART);
		setAuxBarWidth(cur.width + (next ? -HISTORY_RAIL_WIDTH_PX : HISTORY_RAIL_WIDTH_PX));
	}, [historyCollapsed, storageService, layoutService, setAuxBarWidth]);

	// Auto-collapse the rail when the CHAT column is squeezed below CHAT_MIN_WIDTH_PX while the rail
	// is open (no bar resize — the user is dragging the bar border). Observing the chat column (not
	// the whole bar) means the threshold is the chat's own width, independent of the rail width.
	useEffect(() => {
		const el = chatColRef.current;
		if (!el || typeof ResizeObserver === 'undefined') { return; }
		const ro = new ResizeObserver(entries => {
			const w = entries[0]?.contentRect.width ?? 0;
			if (w > 0 && w < CHAT_MIN_WIDTH_PX && !historyCollapsed) {
				setHistoryCollapsed(true);
				storageService.store(HISTORY_COLLAPSED_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [historyCollapsed, storageService]);

	return <div
		className={`@@vibe-scope ${isDark ? 'dark' : ''}`}
		style={{ width: '100%', height: '100%' }}
	>
		<div className="w-full h-full bg-vibe-bg-2 text-vibe-fg-1 flex flex-col">

			{/* Columns: chat (left) + collapsible history rail (right) */}
			<div className="w-full flex-1 min-h-0 flex flex-row">
				{/* Left column — chat tabs (multi-chat) + chat. Fills the bar minus the history rail. */}
				<div ref={chatColRef} className="flex-1 min-w-0 h-full flex flex-col">
					<ChatTabStrip historyCollapsed={historyCollapsed} onToggleHistory={toggleHistory} />
					<div className="flex-1 min-h-0">
						<ErrorBoundary>
							<SidebarChat key={currentThreadId} />
						</ErrorBoundary>
					</div>
				</div>

				{/* Right rail — "История" header + history list (hidden when collapsed) */}
				{!historyCollapsed && (
					<div
						className="h-full flex-shrink-0 border-l border-vibe-border-1 overflow-hidden flex flex-col"
						style={{ width: HISTORY_RAIL_WIDTH_PX }}
					>
						<div className="h-[34px] flex-shrink-0 flex items-center justify-between px-2 border-b border-vibe-border-1">
							<span className="text-[10px] font-semibold uppercase tracking-widest text-vibe-fg-4 select-none">{chatS.historyRailTitle}</span>
							<button
								type="button"
								className="px-1 rounded text-vibe-fg-3 hover:text-vibe-fg-1 hover:bg-vibe-bg-3"
								title={chatS.historyCollapseTooltip}
								onClick={toggleHistory}
							><PanelRightClose size={13} /></button>
						</div>
						<div className="flex-1 min-h-0">
							<ErrorBoundary>
								<SidebarHistory />
							</ErrorBoundary>
						</div>
					</div>
				)}
			</div>
		</div>
	</div>;
};
