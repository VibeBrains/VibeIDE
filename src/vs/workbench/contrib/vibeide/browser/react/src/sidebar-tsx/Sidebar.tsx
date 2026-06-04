/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useState } from 'react';
import { useIsDark, useAccessor, useChatThreadsState } from '../util/services.js';
import { X as IconClose, Plus as IconPlus, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { StorageScope, StorageTarget } from '../../../../../../../platform/storage/common/storage.js';
import { chatS } from '../vibe-settings-tsx/vibeSettingsRu.js';

import '../styles.css'
import { SidebarChat } from './SidebarChat.js';
import { SidebarHistory } from './SidebarHistory.js';
import ErrorBoundary from './ErrorBoundary.js';

const HISTORY_RAIL_WIDTH_PX = 260;
const HISTORY_COLLAPSED_KEY = 'vibeide.chatHistoryRailCollapsed';

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
	return (
		<div className="h-[34px] flex items-center gap-1 px-1 border-b border-vibe-border-1 overflow-x-auto flex-shrink-0 bg-vibe-bg-2">
			{openTabIds.map(id => {
				const thread = state.allThreads[id];
				const active = id === current;
				const label = tabLabel(thread);
				return (
					<div
						key={id}
						onClick={() => chatThreadsService.switchToThread(id)}
						title={label}
						className={`group flex items-center gap-1 px-2 py-1 rounded-t text-xs cursor-pointer whitespace-nowrap max-w-[160px] border-b-2 ${active
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

	const isDark = useIsDark()
	const accessor = useAccessor()
	const storageService = accessor.get('IStorageService')
	// Re-key the chat by active thread so switching tabs fully re-renders it for the new thread.
	const { currentThreadId } = useChatThreadsState()

	const [historyCollapsed, setHistoryCollapsed] = useState<boolean>(() => storageService.getBoolean(HISTORY_COLLAPSED_KEY, StorageScope.PROFILE, false))
	const toggleHistory = () => {
		const next = !historyCollapsed
		setHistoryCollapsed(next)
		storageService.store(HISTORY_COLLAPSED_KEY, next, StorageScope.PROFILE, StorageTarget.USER)
	}

	return <div
		className={`@@vibe-scope ${isDark ? 'dark' : ''}`}
		style={{ width: '100%', height: '100%' }}
	>
		<div className="w-full h-full bg-vibe-bg-2 text-vibe-fg-1 flex flex-col">

			{/* Columns: chat (left) + collapsible history rail (right) */}
			<div className="w-full flex-1 min-h-0 flex flex-row">
				{/* Left column — chat tabs (multi-chat) + chat */}
				<div className="flex-1 min-w-0 h-full flex flex-col">
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
	</div>
}
