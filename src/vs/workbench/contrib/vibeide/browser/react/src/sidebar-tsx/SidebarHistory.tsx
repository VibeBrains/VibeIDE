/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useIsDark, useAccessor, useChatThreadsState, useFullChatThreadsStreamState } from '../util/services.js';
import { PastThreadElement } from './SidebarThreadSelector.js';
import '../styles.css';
import ErrorBoundary from './ErrorBoundary.js';
import { Search, RotateCcw, Settings as SettingsIcon } from 'lucide-react';
import { IsRunningType, ThreadType } from '../../../chatThreadService.js';
import { chatS } from '../vibe-settings-tsx/vibeSettingsRu.js';
import type { TokenBudgetStatus } from '../../../../common/vibeTokenBudgetService.js';
import type { ContextLimitStatus } from '../../../vibeContextGuardService.js';

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
					/>
				))}
			</div>
		</div>
	);
};

// ---------------------------------------------------------------------------
// TokenBudgetFooter — session token budget + per-message context window readout
// ---------------------------------------------------------------------------

const formatTokens = (n: number): string => n.toLocaleString('ru-RU');

const TokenBudgetFooter = () => {
	const accessor = useAccessor();
	const budgetService = accessor.get('IVibeTokenBudgetService');
	const contextGuard = accessor.get('IVibeContextGuardService');
	const commandService = accessor.get('ICommandService');
	const configurationService = accessor.get('IConfigurationService');

	const [budget, setBudget] = useState<TokenBudgetStatus>(() => budgetService.getStatus());
	const [ctx, setCtx] = useState<ContextLimitStatus>(() => contextGuard.getStatus());

	useEffect(() => {
		const d1 = budgetService.onBudgetStatusChanged((s: TokenBudgetStatus) => setBudget(s));
		const d2 = contextGuard.onUsageUpdated((s: ContextLimitStatus) => setCtx(s));
		return () => { d1.dispose(); d2.dispose(); };
	}, [budgetService, contextGuard]);

	const onReset = useCallback(() => {
		void commandService.executeCommand('vibeide.tokenBudget.reset');
	}, [commandService]);

	const onOpenSettings = useCallback(() => {
		void commandService.executeCommand('workbench.action.openSettings', 'vibeide.safety');
	}, [commandService]);

	const sessionEnabled = budget.sessionTokensLimit > 0;
	const sessionPct = sessionEnabled ? Math.min(100, Math.max(0, Math.round(budget.percentUsed))) : 0;
	const sessionBarClass = budget.isExceeded
		? 'bg-red-500'
		: budget.isWarning ? 'bg-amber-500' : 'bg-green-500';
	// Pulse the SESSION token line (not chat timestamps) while in the ≥80% warning band
	// (below 100%). Honors the vibeide.safety.sessionTokenWarningBlink opt-out. Read in render
	// (the footer re-renders on every budget change, which is exactly when the blink matters).
	const sessionBlink = sessionEnabled && budget.isWarning && !budget.isExceeded
		&& (configurationService.getValue<boolean>('vibeide.safety.sessionTokenWarningBlink') ?? true);
	const sessionWarnTitle = sessionBlink
		? `Сессия израсходовала ${sessionPct}% токенов — сбросьте сессию или поднимите лимит в настройках`
		: undefined;

	const ctxKnown = ctx.maxTokens > 0;
	const ctxPct = ctxKnown ? Math.min(100, Math.max(0, Math.round(ctx.percentUsed))) : 0;
	const ctxBarClass = ctx.isCritical
		? 'bg-red-500'
		: ctx.isWarning ? 'bg-amber-500' : 'bg-vibe-fg-4';

	return (
		<div className="flex-shrink-0 border-t border-vibe-border-1 px-2 py-2 text-[11px] text-vibe-fg-2 select-none">
			<div className={`flex items-center justify-between gap-2 mb-1${sessionBlink ? ' @@vibe-token-warn-blink' : ''}`} title={sessionWarnTitle} style={sessionBlink ? { color: 'var(--vibe-warning)' } : undefined}>
				<span className={`truncate${sessionBlink ? '' : ' text-vibe-fg-3'}`}>{chatS.budgetFooterSessionLabel}</span>
				<span className="font-mono text-[10.5px] truncate">
					{sessionEnabled
						? chatS.budgetFooterCounts(formatTokens(budget.sessionTokensUsed), formatTokens(budget.sessionTokensLimit), sessionPct)
						: `${formatTokens(budget.sessionTokensUsed)} · ${chatS.budgetFooterDisabled}`}
				</span>
			</div>
			{sessionEnabled && (
				<div className="h-1 w-full bg-vibe-bg-1 rounded overflow-hidden mb-1.5">
					<div className={`h-full ${sessionBarClass}`} style={{ width: `${sessionPct}%` }} />
				</div>
			)}
			<div className="flex items-center justify-between gap-2 mb-1">
				<span className="text-vibe-fg-3 truncate">{chatS.budgetFooterContextLabel}</span>
				<span className="font-mono text-[10.5px] truncate">
					{ctxKnown
						? chatS.budgetFooterCounts(formatTokens(ctx.currentTokens), formatTokens(ctx.maxTokens), ctxPct)
						: chatS.budgetFooterUnknown}
				</span>
			</div>
			{ctxKnown && (
				<div className="h-1 w-full bg-vibe-bg-1 rounded overflow-hidden mb-2">
					<div className={`h-full ${ctxBarClass}`} style={{ width: `${ctxPct}%` }} />
				</div>
			)}
			<div className="flex gap-1">
				<button
					type="button"
					onClick={onReset}
					title={chatS.budgetFooterResetTitle}
					aria-label={chatS.budgetFooterResetAria}
					className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded bg-vibe-bg-1 hover:bg-vibe-bg-3 text-vibe-fg-2"
				>
					<RotateCcw size={12} />
				</button>
				<button
					type="button"
					onClick={onOpenSettings}
					title={chatS.budgetFooterSettingsTitle}
					aria-label={chatS.budgetFooterSettingsAria}
					className="flex items-center justify-center px-2 py-1 rounded bg-vibe-bg-1 hover:bg-vibe-bg-3 text-vibe-fg-2"
				>
					<SettingsIcon size={12} />
				</button>
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
						placeholder={chatS.historySearchPlaceholder}
						className="flex-1 bg-transparent text-xs text-vibe-fg-2 outline-none placeholder:text-vibe-fg-4 min-w-0"
					/>
				</div>
			</div>

			{/* Thread list */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden">
				{!hasThreads ? (
					<div className="px-3 py-6 text-xs text-vibe-fg-3 text-center select-none">
						{chatS.historyEmptyState}
					</div>
				) : filter.trim() ? (
					filteredThreads.length === 0 ? (
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

			{/* Sticky footer: session token budget + context window readout */}
			<TokenBudgetFooter />
		</div>
	);
};

export const SidebarHistory = () => {
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
