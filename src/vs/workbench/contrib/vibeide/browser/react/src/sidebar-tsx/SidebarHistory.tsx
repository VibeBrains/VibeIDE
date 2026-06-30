/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { useCallback, useEffect, useMemo, useState } from 'react';
import { useIsDark, useAccessor, useChatThreadsState, useFullChatThreadsStreamState } from '../util/services.js';
import { trackRenderLoop } from '../util/renderLoopGuard.js';
import { PastThreadElement, useHistoryScope, HistoryScopeToggle, type HistoryScope } from './SidebarThreadSelector.js';
import '../styles.css';
import ErrorBoundary from './ErrorBoundary.js';
import { Search, RotateCcw, Settings as SettingsIcon } from 'lucide-react';
import { IsRunningType, ThreadType } from '../../../chatThreadService.js';
import type { ChatMessage } from '../../../../common/chatThreadServiceTypes.js';
import { threadMatchesWorkspace } from '../../../../common/chatHistoryScope.js';
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
// TokenBudgetFooter — session token budget + per-message context window readout
// ---------------------------------------------------------------------------

const formatTokens = (n: number): string => n.toLocaleString('ru-RU');

export const TokenBudgetFooter = () => {
	const accessor = useAccessor();
	const budgetService = accessor.get('IVibeTokenBudgetService');
	const contextGuard = accessor.get('IVibeContextGuardService');
	const commandService = accessor.get('ICommandService');
	const configurationService = accessor.get('IConfigurationService');

	const [budget, setBudget] = useState<TokenBudgetStatus>(() => budgetService.getStatus());
	const [ctx, setCtx] = useState<ContextLimitStatus>(() => contextGuard.getStatus());
	const [blinkEnabled, setBlinkEnabled] = useState<boolean>(() => configurationService.getValue<boolean>('vibeide.safety.sessionTokenWarningBlink') ?? true);

	useEffect(() => {
		const d1 = budgetService.onBudgetStatusChanged((s: TokenBudgetStatus) => setBudget(s));
		const d2 = contextGuard.onUsageUpdated((s: ContextLimitStatus) => setCtx(s));
		// Subscribe to the opt-out so toggling it takes effect immediately — even while idle
		// at a warning (when no budget change would otherwise re-render the footer).
		const d3 = configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.safety.sessionTokenWarningBlink')) {
				setBlinkEnabled(configurationService.getValue<boolean>('vibeide.safety.sessionTokenWarningBlink') ?? true);
			}
		});
		return () => { d1.dispose(); d2.dispose(); d3.dispose(); };
	}, [budgetService, contextGuard, configurationService]);

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
	// (below 100%). Honors the vibeide.safety.sessionTokenWarningBlink opt-out (reactive via
	// the config subscription above, so toggling it applies immediately even when idle).
	const sessionBlink = sessionEnabled && budget.isWarning && !budget.isExceeded && blinkEnabled;
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
			<div
				className={sessionBlink
					? 'flex items-center justify-between gap-2 mb-1 @@vibe-token-warn-blink'
					: 'flex items-center justify-between gap-2 mb-1'}
				title={sessionWarnTitle}
				style={sessionBlink ? { color: 'var(--vibe-warning)' } : undefined}
			>
				<span className={sessionBlink ? 'truncate' : 'truncate text-vibe-fg-3'}>{chatS.budgetFooterSessionLabel}</span>
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

	const threadMatchesQuery = useCallback((t: ThreadType, q: string): boolean => {
		const fu = t.messages.find((m): m is ChatMessage & { role: 'user' } => m.role === 'user');
		return (fu?.displayContent || fu?.content || '').toLowerCase().includes(q);
	}, []);

	const filteredThreads = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) { return sortedThreads; }
		return sortedThreads.filter(t => threadMatchesQuery(t, q));
	}, [sortedThreads, filter, threadMatchesQuery]);

	// CH.9 — when searching in scoped mode, count matches hiding in OTHER projects
	// so a chat made elsewhere never looks "lost". Only meaningful while scoped.
	const otherMatchesCount = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q || showAll) { return 0; }
		return messageThreads.filter(t => !threadMatchesWorkspace(t, wsId, false) && threadMatchesQuery(t, q)).length;
	}, [messageThreads, filter, showAll, wsId, threadMatchesQuery]);

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

			{/* Session token budget + context window readout now lives in the always-visible Sidebar
			    footer (so collapsing the history rail doesn't hide it) — rendered by Sidebar.tsx. */}
		</div>
	);
};

/** Compact one-line readout `| Окно X·P% | Сессия Y·P%` for the chat context line (refactor B:
 * the full TokenBudgetFooter with bars/buttons was too tall; this rides inline next to "Контекст"). */
export const TokenBudgetInline = () => {
	const accessor = useAccessor();
	const budgetService = accessor.get('IVibeTokenBudgetService');
	const contextGuard = accessor.get('IVibeContextGuardService');
	const [budget, setBudget] = useState<TokenBudgetStatus>(() => budgetService.getStatus());
	const [ctx, setCtx] = useState<ContextLimitStatus>(() => contextGuard.getStatus());
	useEffect(() => {
		const d1 = budgetService.onBudgetStatusChanged((s: TokenBudgetStatus) => setBudget(s));
		const d2 = contextGuard.onUsageUpdated((s: ContextLimitStatus) => setCtx(s));
		return () => { d1.dispose(); d2.dispose(); };
	}, [budgetService, contextGuard]);

	const sessionEnabled = budget.sessionTokensLimit > 0;
	const sessionPct = sessionEnabled ? Math.min(100, Math.max(0, Math.round(budget.percentUsed))) : 0;
	const ctxKnown = ctx.maxTokens > 0;
	const ctxPct = ctxKnown ? Math.min(100, Math.max(0, Math.round(ctx.percentUsed))) : 0;
	const sep = <span className="text-vibe-fg-4 mx-1.5 select-none">|</span>;
	return (
		<span className="text-vibe-fg-3 whitespace-nowrap">
			{sep}<span>{chatS.budgetFooterContextLabel}: {ctxKnown ? `${formatTokens(ctx.currentTokens)}·${ctxPct}%` : chatS.budgetFooterUnknown}</span>
			{sep}<span>{chatS.budgetFooterSessionLabel}: {sessionEnabled ? `${formatTokens(budget.sessionTokensUsed)}·${sessionPct}%` : formatTokens(budget.sessionTokensUsed)}</span>
		</span>
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
