/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { useCallback, useMemo, useState } from 'react';
import { useIsDark, useAccessor, useChatThreadsState, useFullChatThreadsStreamState } from '../util/services.js';
import { trackRenderLoop } from '../util/renderLoopGuard.js';
import { PastThreadElement, useHistoryScope, HistoryScopeToggle, type HistoryScope } from './SidebarThreadSelector.js';
import '../styles.css';
import ErrorBoundary from './ErrorBoundary.js';
import { Search } from 'lucide-react';
import { IsRunningType, ThreadType } from '../../../chatThreadService.js';
import { threadMatchesWorkspace } from '../../../../common/chatHistoryScope.js';
import { useThreadSearch } from '../util/threadSearch.js';
import { chatS } from '../vibe-settings-tsx/vibeSettingsRu.js';

const OPEN_CHAT_CMD = 'vibeide.chat.open';

// ---------------------------------------------------------------------------
// Date grouping helpers
// ---------------------------------------------------------------------------

type DateGroupLabel = 'Today' | 'Yesterday' | 'Last 7 days' | 'Last 30 days' | 'Older';
const DATE_GROUP_ORDER: DateGroupLabel[] = ['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'Older'];

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number): Date => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

const getDateGroup = (lastModified: string | number): DateGroupLabel => {
	const now = new Date();
	const today = startOfDay(now);
	const yesterday = startOfDay(addDays(now, -1));
	const last7 = startOfDay(addDays(now, -7));
	const last30 = startOfDay(addDays(now, -30));
	const date = new Date(lastModified as string);
	if (date >= today) { return 'Today'; }
	if (date >= yesterday) { return 'Yesterday'; }
	if (date >= last7) { return 'Last 7 days'; }
	if (date >= last30) { return 'Last 30 days'; }
	return 'Older';
};

const groupThreadsByDate = (threads: ThreadType[]): Map<DateGroupLabel, ThreadType[]> => {
	const groups = new Map<DateGroupLabel, ThreadType[]>(DATE_GROUP_ORDER.map(g => [g, []]));
	for (const t of threads) {
		groups.get(getDateGroup(t.lastModified))!.push(t);
	}
	for (const [key, val] of groups) {
		if (val.length === 0) { groups.delete(key); }
	}
	return groups;
};

function dateGroupDisplayLabel(label: DateGroupLabel): string {
	switch (label) {
		case 'Today': return chatS.historyDateToday;
		case 'Yesterday': return chatS.historyDateYesterday;
		case 'Last 7 days': return chatS.historyDateLast7;
		case 'Last 30 days': return chatS.historyDateLast30;
		case 'Older': return chatS.historyDateOlder;
	}
}

// ---------------------------------------------------------------------------
// DateGroupSection
// ---------------------------------------------------------------------------

const DateGroupSection = ({
	label,
	threads,
	currentThreadId,
	runningThreadIds,
	onAfterSwitch,
	scope,
}: {
	label: DateGroupLabel;
	threads: ThreadType[];
	currentThreadId: string | undefined;
	runningThreadIds: Record<string, IsRunningType | undefined>;
	onAfterSwitch: () => void;
	scope: HistoryScope;
}) => {
	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

	return (
		<div className="mb-1">
			<div className="px-2 pt-3 pb-0.5 text-[10px] font-semibold uppercase tracking-widest text-vibe-fg-4 select-none">
				{dateGroupDisplayLabel(label)}
			</div>
			<div className="flex flex-col gap-1 px-2">
				{threads.map((thread, i) => (
					<PastThreadElement
						key={thread.id}
						pastThread={thread}
						idx={i}
						hoveredIdx={hoveredIdx}
						setHoveredIdx={setHoveredIdx}
						isRunning={runningThreadIds[thread.id]}
						isActive={thread.id === currentThreadId}
						onAfterSwitch={onAfterSwitch}
						scope={scope}
					/>
				))}
			</div>
		</div>
	);
};

// ---------------------------------------------------------------------------
// HistoryContent
// ---------------------------------------------------------------------------

const HistoryContent = () => {
	const [filter, setFilter] = useState('');
	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const commandService = accessor.get('ICommandService');
	const threadsState = useChatThreadsState();
	const streamState = useFullChatThreadsStreamState();

	// currentThreadId is part of the service state; read it on every render so
	// it stays in sync with thread switches (threadsState changes trigger re-render).
	const currentThreadId: string | undefined = chatThreadsService.state?.currentThreadId;

	const runningThreadIds = useMemo(() => {
		const result: Record<string, IsRunningType | undefined> = {};
		for (const id in streamState) {
			const isRunning = streamState[id]?.isRunning;
			if (isRunning) { result[id] = isRunning; }
		}
		return result;
	}, [streamState]);

	const { showAll, setShowAll, wsId } = useHistoryScope();

	const messageThreads = useMemo((): ThreadType[] => {
		return Object.values(threadsState.allThreads ?? {})
			.filter((t): t is ThreadType => !!(t as ThreadType)?.messages?.length)
			.sort((a, b) => {
				const aM = a.lastModified;
				const bM = b.lastModified;
				return bM > aM ? 1 : bM < aM ? -1 : 0;
			});
	}, [threadsState.allThreads]);

	// Scoped to the current project unless the user opted into "all projects".
	const sortedThreads = useMemo((): ThreadType[] => {
		return messageThreads.filter(t => threadMatchesWorkspace(t, wsId, showAll));
	}, [messageThreads, wsId, showAll]);

	const otherProjectsCount = useMemo(() => {
		return messageThreads.filter(t => !threadMatchesWorkspace(t, wsId, false)).length;
	}, [messageThreads, wsId]);

	const scope = useMemo((): HistoryScope => ({ showAll, currentWorkspaceId: wsId }), [showAll, wsId]);

	// Whole-transcript search, debounced inside the hook and shared with the composer dropdown.
	const hitsByThreadId = useThreadSearch(messageThreads, filter);

	const filteredThreads = useMemo(() => {
		if (!hitsByThreadId) { return sortedThreads; }
		// Kept in the list's own order (recency, grouping) rather than by score: the user is
		// filtering a list they already know, and re-sorting it under them loses the place.
		return sortedThreads.filter(t => hitsByThreadId.has(t.id));
	}, [sortedThreads, hitsByThreadId]);

	// CH.9 — when searching in scoped mode, count matches hiding in OTHER projects
	// so a chat made elsewhere never looks "lost". Only meaningful while scoped.
	const otherMatchesCount = useMemo(() => {
		if (!hitsByThreadId || showAll) { return 0; }
		return messageThreads.filter(t => !threadMatchesWorkspace(t, wsId, false) && hitsByThreadId.has(t.id)).length;
	}, [messageThreads, hitsByThreadId, showAll, wsId]);

	// The excerpt is only worth showing when the title does not already contain the query —
	// otherwise the row would repeat itself.
	const matchOf = useCallback((thread: ThreadType): { text: string; role: 'user' | 'assistant' | 'other' } | undefined => {
		const hit = hitsByThreadId?.get(thread.id);
		if (!hit || hit.messageIndex === 0) { return undefined; }
		return { text: hit.excerpt, role: hit.role };
	}, [hitsByThreadId]);

	const dateGroups = useMemo(() => {
		if (filter.trim()) { return null; }
		return groupThreadsByDate(sortedThreads);
	}, [sortedThreads, filter]);

	// Stable identity so memo'd PastThreadElement rows don't all re-render when SidebarHistory re-renders.
	const handleAfterSwitch = useCallback((): void => { void commandService.executeCommand(OPEN_CHAT_CMD); }, [commandService]);

	const hasThreads = sortedThreads.length > 0;

	return (
		<div className="flex flex-col h-full w-full overflow-hidden">
			{/* Search */}
			<div className="px-2 py-1.5 flex-shrink-0 flex flex-col gap-1.5">
				<div className="flex items-center gap-1.5 px-2 py-1 @@vibe-command-center-search">
					<Search size={11} className="text-vibe-fg-4 shrink-0" />
					<input
						type="search"
						value={filter}
						onChange={e => setFilter(e.target.value)}
						onKeyDown={e => e.stopPropagation()}
						placeholder={chatS.historySearchPlaceholder}
						className="flex-1 bg-transparent text-xs text-vibe-fg-2 outline-none placeholder:text-vibe-fg-4 min-w-0"
					/>
				</div>
				{otherProjectsCount > 0 && (
					<div className="flex justify-end">
						<HistoryScopeToggle showAll={showAll} setShowAll={setShowAll} otherCount={otherProjectsCount} />
					</div>
				)}
			</div>

			{/* Thread list */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden">
				{!hasThreads ? (
					<div className="px-3 py-6 text-xs text-vibe-fg-3 text-center select-none">
						{chatS.historyEmptyState}
					</div>
				) : filter.trim() ? (
					<>
						{otherMatchesCount > 0 && (
							<button
								type="button"
								className="w-full text-left px-3 py-2 text-xs text-vibe-fg-3 hover:text-vibe-fg-1 hover:bg-vibe-bg-3 transition-colors select-none"
								onClick={() => setShowAll(true)}
							>
								{chatS.historyOtherMatches(otherMatchesCount)}
							</button>
						)}
						{filteredThreads.length === 0 ? (
							<div className="px-3 py-4 text-xs text-vibe-fg-3 text-center select-none">
								{chatS.historyNoMatches(filter)}
							</div>
						) : (
							<div className="flex flex-col gap-1 px-2 py-2">
								{filteredThreads.map((thread, i) => (
									<PastThreadElement
										key={thread.id}
										pastThread={thread}
										idx={i}
										hoveredIdx={hoveredIdx}
										setHoveredIdx={setHoveredIdx}
										isRunning={runningThreadIds[thread.id]}
										isActive={thread.id === currentThreadId}
										onAfterSwitch={handleAfterSwitch}
										scope={scope}
										match={matchOf(thread)}
									/>
								))}
							</div>
						)}
					</>
				) : (
					dateGroups && (Array.from(dateGroups.entries()) as [DateGroupLabel, ThreadType[]][]).map(([label, threads]) => (
						<DateGroupSection
							key={label}
							label={label}
							threads={threads}
							currentThreadId={currentThreadId}
							runningThreadIds={runningThreadIds}
							onAfterSwitch={handleAfterSwitch}
							scope={scope}
						/>
					))
				)}
			</div>
		</div>
	);
};

export const SidebarHistory = () => {
	trackRenderLoop('SidebarHistory');
	const isDark = useIsDark();
	return (
		<div
			className={`@@vibe-scope @@vibe-chat-neon-scope ${isDark ? 'dark' : ''}`}
			style={{ width: '100%', height: '100%' }}
		>
			<div className="w-full h-full bg-vibe-bg-2 text-vibe-fg-1">
				<ErrorBoundary>
					<HistoryContent />
				</ErrorBoundary>
			</div>
		</div>
	);
};
