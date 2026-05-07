/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useState } from 'react';
import { useIsDark, useAccessor, useChatThreadsState, useFullChatThreadsStreamState } from '../util/services.js';
import { PastThreadElement } from './SidebarThreadSelector.js';
import '../styles.css';
import ErrorBoundary from './ErrorBoundary.js';
import { Search } from 'lucide-react';
import { IsRunningType, ThreadType } from '../../../chatThreadService.js';

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

// ---------------------------------------------------------------------------
// DateGroupSection
// ---------------------------------------------------------------------------

const DateGroupSection = ({
	label,
	threads,
	currentThreadId,
	runningThreadIds,
	onAfterSwitch,
}: {
	label: DateGroupLabel;
	threads: ThreadType[];
	currentThreadId: string | undefined;
	runningThreadIds: Record<string, IsRunningType | undefined>;
	onAfterSwitch: () => void;
}) => {
	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

	return (
		<div className="mb-1">
			<div className="px-2 pt-3 pb-0.5 text-[10px] font-semibold uppercase tracking-widest text-vibe-fg-4 select-none">
				{label}
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
	const currentThreadId: string | undefined = (chatThreadsService as any).state?.currentThreadId;

	const runningThreadIds = useMemo(() => {
		const result: Record<string, IsRunningType | undefined> = {};
		for (const id in streamState) {
			const isRunning = streamState[id]?.isRunning;
			if (isRunning) { result[id] = isRunning; }
		}
		return result;
	}, [streamState]);

	const sortedThreads = useMemo((): ThreadType[] => {
		return Object.values(threadsState.allThreads ?? {})
			.filter((t): t is ThreadType => !!(t as ThreadType)?.messages?.length)
			.sort((a, b) => {
				const aM = a.lastModified;
				const bM = b.lastModified;
				return bM > aM ? 1 : bM < aM ? -1 : 0;
			});
	}, [threadsState.allThreads]);

	const filteredThreads = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) { return sortedThreads; }
		return sortedThreads.filter(t => {
			const fu = t.messages.find(m => m.role === 'user') as any;
			return ((fu?.displayContent || fu?.content || '') as string).toLowerCase().includes(q);
		});
	}, [sortedThreads, filter]);

	const dateGroups = useMemo(() => {
		if (filter.trim()) { return null; }
		return groupThreadsByDate(sortedThreads);
	}, [sortedThreads, filter]);

	const handleAfterSwitch = (): void => { void commandService.executeCommand(OPEN_CHAT_CMD); };

	const hasThreads = sortedThreads.length > 0;

	return (
		<div className="flex flex-col h-full w-full overflow-hidden">
			{/* Search */}
			<div className="px-2 py-1.5 flex-shrink-0">
				<div className="flex items-center gap-1.5 px-2 py-1 @@vibe-command-center-search">
					<Search size={11} className="text-vibe-fg-4 shrink-0" />
					<input
						type="search"
						value={filter}
						onChange={e => setFilter(e.target.value)}
						onKeyDown={e => e.stopPropagation()}
						placeholder="Поиск"
						className="flex-1 bg-transparent text-xs text-vibe-fg-2 outline-none placeholder:text-vibe-fg-4 min-w-0"
					/>
				</div>
			</div>

			{/* Thread list */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden">
				{!hasThreads ? (
					<div className="px-3 py-6 text-xs text-vibe-fg-3 text-center select-none">
						No chat history yet.
					</div>
				) : filter.trim() ? (
					filteredThreads.length === 0 ? (
						<div className="px-3 py-4 text-xs text-vibe-fg-3 text-center select-none">
							No matches for &ldquo;{filter}&rdquo;
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
								/>
							))}
						</div>
					)
				) : (
					dateGroups && (Array.from(dateGroups.entries()) as [DateGroupLabel, ThreadType[]][]).map(([label, threads]) => (
						<DateGroupSection
							key={label}
							label={label}
							threads={threads}
							currentThreadId={currentThreadId}
							runningThreadIds={runningThreadIds}
							onAfterSwitch={handleAfterSwitch}
						/>
					))
				)}
			</div>
		</div>
	);
};

export const SidebarHistory = () => {
	const isDark = useIsDark();
	return (
		<div
			className={`@@vibe-scope ${isDark ? 'dark' : ''}`}
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
