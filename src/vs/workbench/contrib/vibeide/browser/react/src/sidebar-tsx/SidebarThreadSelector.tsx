/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { useMemo, useState, useCallback, useLayoutEffect, useEffect, useRef, memo } from 'react';
import { useFloating, autoUpdate, offset, flip, shift, size } from '@floating-ui/react';
import { chatS } from '../vibe-settings-tsx/vibeSettingsRu.js';
import { IconShell1 } from '../markdown/ApplyBlockHoverButtons.js';
import { useAccessor, useChatThreadsState, useFullChatThreadsStreamState } from '../util/services.js';
import { IconX } from './SidebarChat.js';
import { Check, Copy, LoaderCircle, MessageCircleQuestion, Trash2, History, X, FolderInput } from 'lucide-react';
import { IsRunningType, ThreadType } from '../../../chatThreadService.js';
import { threadMatchesWorkspace, HISTORY_SHOW_ALL_PROJECTS_KEY } from '../../../../common/chatHistoryScope.js';
import { StorageScope } from '../../../../../../../platform/storage/common/storage.js';
import { DisposableStore } from '../../../../../../../base/common/lifecycle.js';

/** History scope passed down to PastThreadElement so it can render the project badge / move action. */
export type HistoryScope = { showAll: boolean; currentWorkspaceId: string };


const numInitialThreads = 3;

/**
 * Shared history-scope state: current workspace id + the persisted
 * "show all projects" toggle. Local state mirrors the service so the toggle
 * re-renders instantly; the service persists it across windows.
 */
export const useHistoryScope = () => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const storageService = accessor.get('IStorageService');
	const [showAll, setShowAllState] = useState(() => chatThreadsService.getHistoryShowAllProjects());
	const wsId = chatThreadsService.getCurrentWorkspaceId();

	// React to the persisted toggle so every mounted history list (and other
	// windows) stay in sync — not just the component that flipped it.
	useEffect(() => {
		const store = new DisposableStore();
		store.add(storageService.onDidChangeValue(StorageScope.PROFILE, HISTORY_SHOW_ALL_PROJECTS_KEY, store)(() => {
			setShowAllState(chatThreadsService.getHistoryShowAllProjects());
		}));
		return () => store.dispose();
	}, [storageService, chatThreadsService]);

	const setShowAll = useCallback((v: boolean) => {
		chatThreadsService.setHistoryShowAllProjects(v); // storage write → onDidChangeValue → all hooks update
	}, [chatThreadsService]);
	return { showAll, setShowAll, wsId };
};

/** Compact "This project / All projects" segmented toggle for the history lists. */
export const HistoryScopeToggle = ({ showAll, setShowAll, otherCount = 0, className = '' }: { showAll: boolean; setShowAll: (v: boolean) => void; otherCount?: number; className?: string }) => {
	return (
		<div className={`inline-flex items-center gap-0.5 text-[10px] rounded-full bg-vibe-bg-2 p-0.5 ${className}`}>
			<button
				type="button"
				className={`px-2 py-0.5 rounded-full transition-colors ${!showAll ? 'bg-vibe-bg-3 text-vibe-fg-1' : 'text-vibe-fg-3 hover:text-vibe-fg-2'}`}
				onClick={() => setShowAll(false)}
			>{chatS.historyScopeThisProject}</button>
			<button
				type="button"
				className={`px-2 py-0.5 rounded-full transition-colors inline-flex items-center gap-1 ${showAll ? 'bg-vibe-bg-3 text-vibe-fg-1' : 'text-vibe-fg-3 hover:text-vibe-fg-2'}`}
				onClick={() => setShowAll(true)}
				title={!showAll && otherCount > 0 ? chatS.historyOtherProjectsHint(otherCount) : undefined}
			>
				{chatS.historyScopeAllProjects}
				{!showAll && otherCount > 0 && (
					<span className="px-1 rounded-full bg-vibe-bg-1 text-[9px] text-vibe-fg-2">+{otherCount}</span>
				)}
			</button>
		</div>
	);
};

export const PastThreadsList = ({ className = '', onAfterSwitch }: { className?: string; onAfterSwitch?: () => void }) => {
	// List-expansion (show all threads vs the first few). Distinct from the
	// project-scope `showAll` below — keep separate names to avoid shadowing.
	const [expanded, setExpanded] = useState(false);

	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

	const threadsState = useChatThreadsState();
	const { allThreads } = threadsState;

	const streamState = useFullChatThreadsStreamState();
	const { showAll, setShowAll, wsId } = useHistoryScope();

	// Memoize runningThreadIds computation to avoid recalculating on every render
	const runningThreadIds = useMemo(() => {
		const result: { [threadId: string]: IsRunningType | undefined } = {};
		for (const threadId in streamState) {
			const isRunning = streamState[threadId]?.isRunning;
			if (isRunning) { result[threadId] = isRunning; }
		}
		return result;
	}, [streamState]);

	// Message-bearing thread ids, newest first (before workspace scoping).
	const messageThreadIds = useMemo(() => {
		return Object.keys(allThreads ?? {})
			.sort((threadId1, threadId2) => (allThreads?.[threadId1]?.lastModified ?? 0) > (allThreads?.[threadId2]?.lastModified ?? 0) ? -1 : 1)
			.filter(threadId => (allThreads?.[threadId]?.messages.length ?? 0) !== 0);
	}, [allThreads]);

	// Scoped to the current project unless the user opted into "all projects".
	const sortedThreadIds = useMemo(() => {
		return messageThreadIds.filter(threadId => threadMatchesWorkspace(allThreads![threadId]!, wsId, showAll));
	}, [messageThreadIds, allThreads, wsId, showAll]);

	// Count of history in OTHER projects — drives the toggle visibility + "+N" hint.
	const otherProjectsCount = useMemo(() => {
		return messageThreadIds.filter(threadId => !threadMatchesWorkspace(allThreads![threadId]!, wsId, false)).length;
	}, [messageThreadIds, allThreads, wsId]);

	if (!allThreads) {
		return <div key="error" className="p-1">{chatS.historyError}</div>;
	}

	// Get only first 5 threads if not expanded
	const hasMoreThreads = sortedThreadIds.length > numInitialThreads;
	const displayThreads = expanded ? sortedThreadIds : sortedThreadIds.slice(0, numInitialThreads);

	return (
		<div className={`@@vibe-chat-neon-scope flex flex-col mb-2 gap-2 w-full text-nowrap text-vibe-fg-2 select-none relative ${className}`}>
			{otherProjectsCount > 0 && (
				<div className="flex justify-end">
					<HistoryScopeToggle showAll={showAll} setShowAll={setShowAll} otherCount={otherProjectsCount} />
				</div>
			)}
			{displayThreads.length === 0 // this should never happen
				? <></>
				: displayThreads.map((threadId, i) => {
					const pastThread = allThreads[threadId];
					if (!pastThread) {
						return <div key={i} className="p-1">{chatS.historyError}</div>;
					}

					return (
						<PastThreadElement
							key={pastThread.id}
							pastThread={pastThread}
							idx={i}
							hoveredIdx={hoveredIdx}
							setHoveredIdx={setHoveredIdx}
							isRunning={runningThreadIds[pastThread.id]}
							onAfterSwitch={onAfterSwitch}
							scope={{ showAll, currentWorkspaceId: wsId }}
						/>
					);
				})
			}

			{hasMoreThreads && !expanded && (
				<div
					className="text-vibe-fg-3 opacity-80 hover:opacity-100 hover:brightness-115 cursor-pointer p-1 text-xs"
					onClick={() => setExpanded(true)}
				>
					{chatS.historyShowMore(sortedThreadIds.length - numInitialThreads)}
				</div>
			)}
			{hasMoreThreads && expanded && (
				<div
					className="text-vibe-fg-3 opacity-80 hover:opacity-100 hover:brightness-115 cursor-pointer p-1 text-xs"
					onClick={() => setExpanded(false)}
				>
					{chatS.historyShowLess}
				</div>
			)}
		</div>
	);
};





// Format date to display as today, yesterday, or date
const formatDate = (date: Date) => {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);

	if (date >= today) {
		return 'Today';
	} else if (date >= yesterday) {
		return 'Yesterday';
	} else {
		return `${date.toLocaleString('default', { month: 'short' })} ${date.getDate()}`;
	}
};

// Format time to 12-hour format
const formatTime = (date: Date) => {
	return date.toLocaleString('en-US', {
		hour: 'numeric',
		minute: '2-digit',
		hour12: true
	});
};


const DuplicateButton = ({ threadId }: { threadId: string }) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	return <IconShell1
		Icon={Copy}
		className='size-[11px]'
		onClick={() => { chatThreadsService.duplicateThread(threadId); }}
	>
	</IconShell1>;

};

const TrashButton = ({ threadId, onPressedChange }: { threadId: string; onPressedChange?: (pressed: boolean) => void }) => {

	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');


	const [isTrashPressed, setIsTrashPressed] = useState(false);

	const setPressed = (v: boolean) => {
		setIsTrashPressed(v);
		onPressedChange?.(v);
	};

	return (isTrashPressed ?
		<div className='flex flex-nowrap text-nowrap gap-1'>
			<IconShell1
				Icon={X}
				className='size-[11px]'
				onClick={() => { setPressed(false); }}
			/>
			<IconShell1
				Icon={Check}
				className='size-[11px]'
				onClick={() => { chatThreadsService.deleteThread(threadId); setPressed(false); }}
			/>
		</div>
		: <IconShell1
			Icon={Trash2}
			className='size-[11px]'
			onClick={() => { setPressed(true); }}
		/>
	);
};

// memo-wrapped: during a state-storm re-render of the history list, only the row whose
// `pastThread` ref actually changed re-renders; the other 100+ rows bail on shallow-equal
// props. Without this, a single _setState re-rendered & re-committed every row, and with a
// large un-virtualized history that compounded into a multi-second renderer freeze
// ("Окно не отвечает") when no project was open (full cross-project history shown).
export const PastThreadElement = memo(({
	pastThread,
	idx,
	hoveredIdx,
	setHoveredIdx,
	isRunning,
	onAfterSwitch,
	isActive = false,
	scope,
}: {
	pastThread: ThreadType;
	idx: number;
	hoveredIdx: number | null;
	setHoveredIdx: (idx: number | null) => void;
	isRunning: IsRunningType | undefined;
	onAfterSwitch?: () => void;
	isActive?: boolean;
	scope?: HistoryScope;
}) => {


	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');

	const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

	// In "all projects" view, a thread that doesn't belong to the open project
	// gets a project badge + a "move here" affordance. Legacy threads (no
	// workspaceId) count as foreign so they can be claimed by the current project.
	const isForeign = !!scope && pastThread.workspaceId !== scope.currentWorkspaceId;
	const showForeign = !!scope?.showAll && isForeign;
	const projectBadgeLabel = pastThread.workspaceLabel || (pastThread.workspaceId ? chatS.historyBadgeOtherProject : chatS.historyBadgeNoProject);

	// const settingsState = useSettingsState()
	// const convertService = accessor.get('IConvertToLLMMessageService')
	// const chatMode = settingsState.globalSettings.chatMode
	// const modelSelection = settingsState.modelSelectionOfFeature?.Chat ?? null
	// const copyChatButton = <CopyButton
	// 	codeStr={async () => {
	// 		const { messages } = await convertService.prepareLLMChatMessages({
	// 			chatMessages: currentThread.messages,
	// 			chatMode,
	// 			modelSelection,
	// 		})
	// 		return JSON.stringify(messages, null, 2)
	// 	}}
	// 	toolTipName={modelSelection === null ? 'Copy As Messages Payload' : `Copy As ${displayInfoOfProviderName(modelSelection.providerName).title} Payload`}
	// />


	// const currentThread = chatThreadsService.getCurrentThread()
	// const copyChatButton2 = <CopyButton
	// 	codeStr={async () => {
	// 		return JSON.stringify(currentThread.messages, null, 2)
	// 	}}
	// 	toolTipName={`Copy As Void Chat`}
	// />

	let firstMsg = null;
	const firstUserMsgIdx = pastThread.messages.findIndex((msg) => msg.role === 'user');

	if (firstUserMsgIdx !== -1) {
		const firsUsertMsgObj = pastThread.messages[firstUserMsgIdx];
		firstMsg = firsUsertMsgObj.role === 'user' && firsUsertMsgObj.displayContent || '';
	} else {
		firstMsg = '""';
	}

	const numMessages = pastThread.messages.filter((msg) => msg.role === 'assistant' || msg.role === 'user').length;

	const detailsHTML = (
		<span
			className='px-2 py-0.5 rounded-full bg-vibe-bg-2 text-[10px] tracking-wide uppercase text-vibe-fg-3'
			style={{ whiteSpace: 'nowrap', display: 'inline-block', flexShrink: 0 }}
		>
			{numMessages}<span className='opacity-50 mx-1'>·</span><span className='opacity-80'>{formatDate(new Date(pastThread.lastModified))}</span>
		</span>
	);

	return <div
		key={pastThread.id}
		className={`
			group relative px-3 py-2 rounded-2xl cursor-pointer text-sm text-vibe-fg-1 transition-colors duration-150 ease-out
			${isActive ? 'bg-vibe-bg-3' : '@@chat-composer-shell'}
		`}
		onClick={() => {
			chatThreadsService.switchToThread(pastThread.id);
			onAfterSwitch?.();
		}}
		onMouseEnter={() => setHoveredIdx(idx)}
		onMouseLeave={() => setHoveredIdx(null)}
	>
		{isActive && (
			<span
				className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-[55%] rounded-full"
				style={{ background: 'var(--vscode-vibeide-chatGroup-activeBorder, #fc28a8)' }}
			/>
		)}
		<div className="flex items-center justify-between gap-2">
			<span className="flex items-center gap-2 min-w-0 overflow-hidden text-vibe-fg-2">
                {/* status icon */}
                {isRunning === 'LLM' || isRunning === 'tool' || isRunning === 'preparing' ? (
                    <LoaderCircle className="animate-spin text-vibe-fg-1 flex-shrink-0 flex-grow-0" size={14} />
                ) : isRunning === 'awaiting_user' ? (
                    <MessageCircleQuestion className="text-vibe-fg-1 flex-shrink-0 flex-grow-0" size={14} />
                ) : null}
				{/* name */}
				<span className="truncate overflow-hidden text-ellipsis text-vibe-fg-1">{firstMsg}</span>

				{/* project badge — only in "all projects" view for foreign threads */}
				{showForeign && (
					<span
						className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-vibe-bg-2 text-[9px] uppercase tracking-wide text-vibe-fg-3 max-w-[120px]"
						title={projectBadgeLabel}
					>
						<FolderInput size={9} className="shrink-0 opacity-70" />
						<span className="truncate">{projectBadgeLabel}</span>
					</span>
				)}

				{/* <span className='opacity-60'>{`(${numMessages})`}</span> */}
			</span>

			<div className="relative flex items-center gap-x-1 opacity-80 text-vibe-fg-3 flex-shrink-0">
				{/* badge: always rendered to lock right-column width */}
				<div
					className='transition-opacity duration-150'
					style={{ opacity: idx === hoveredIdx ? 0 : 0.9, visibility: idx === hoveredIdx ? 'hidden' : 'visible' }}
				>
					{detailsHTML}
				</div>
				{/* action icons: absolute overlay, only visible on hover */}
				{idx === hoveredIdx && (
					<div className="absolute inset-y-0 right-0 flex items-center gap-x-1">
						{showForeign && !isConfirmingDelete && (
							<IconShell1
								Icon={FolderInput}
								className='size-[11px]'
								title={chatS.historyMoveToProject}
								onClick={() => { chatThreadsService.moveThreadToCurrentWorkspace(pastThread.id); }}
							/>
						)}
						{!isConfirmingDelete && <DuplicateButton threadId={pastThread.id} />}
						<TrashButton threadId={pastThread.id} onPressedChange={setIsConfirmingDelete} />
					</div>
				)}
			</div>
		</div>
	</div>;
});


/** Composer toolbar control: anchored popover listing past threads (same pattern as ChatModeDropdown). */
export const ChatHistoryToolbarDropdown: React.FC<{ className?: string }> = ({ className }) => {
	const accessor = useAccessor();
	const threadsState = useChatThreadsState();
	const streamState = useFullChatThreadsStreamState();
	const chatThreadsService = accessor.get('IChatThreadService');

	const [isOpen, setIsOpen] = useState(false);
	const [filter, setFilter] = useState('');
	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
	const { showAll, setShowAll, wsId } = useHistoryScope();

	const messageThreadIds = useMemo(() => {
		const { allThreads } = threadsState;
		if (!allThreads) {
			return [];
		}
		return Object.keys(allThreads)
			.sort((a, b) => (allThreads[a]?.lastModified ?? 0) > (allThreads[b]?.lastModified ?? 0) ? -1 : 1)
			.filter(id => (allThreads[id]?.messages.length ?? 0) !== 0);
	}, [threadsState]);

	const sortedThreadIds = useMemo(() => {
		const { allThreads } = threadsState;
		return messageThreadIds.filter(id => threadMatchesWorkspace(allThreads![id]!, wsId, showAll));
	}, [messageThreadIds, threadsState, wsId, showAll]);

	const otherProjectsCount = useMemo(() => {
		const { allThreads } = threadsState;
		return messageThreadIds.filter(id => !threadMatchesWorkspace(allThreads![id]!, wsId, false)).length;
	}, [messageThreadIds, threadsState, wsId]);

	const filteredIds = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) {
			return sortedThreadIds;
		}
		const { allThreads } = threadsState;
		if (!allThreads) {
			return [];
		}
		return sortedThreadIds.filter(id => {
			const t = allThreads[id];
			if (!t) {
				return false;
			}
			const fu = t.messages.find(m => m.role === 'user');
			const text = ((fu?.displayContent || fu?.content || '') + '').toLowerCase();
			return text.includes(q);
		});
	}, [sortedThreadIds, filter, threadsState]);

	// CH.12 — matches hiding in OTHER projects while scoped, so a chat made elsewhere
	// never looks lost (parity with the full history panel, CH.9).
	const otherMatchesCount = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q || showAll) { return 0; }
		const { allThreads } = threadsState;
		if (!allThreads) { return 0; }
		return messageThreadIds.filter(id => {
			const t = allThreads[id];
			if (!t || threadMatchesWorkspace(t, wsId, false)) { return false; }
			const fu = t.messages.find(m => m.role === 'user');
			return ((fu?.displayContent || fu?.content || '') + '').toLowerCase().includes(q);
		}).length;
	}, [messageThreadIds, filter, showAll, wsId, threadsState]);

	const runningThreadIds = useMemo(() => {
		const result: { [threadId: string]: IsRunningType | undefined } = {};
		for (const threadId in streamState) {
			const isRunning = streamState[threadId]?.isRunning;
			if (isRunning) {
				result[threadId] = isRunning;
			}
		}
		return result;
	}, [streamState]);

	const close = useCallback(() => setIsOpen(false), []);

	useLayoutEffect(() => {
		if (chatThreadsService.pullChatHistoryPopoverPending()) {
			setIsOpen(true);
		}
		const d = chatThreadsService.onDidRequestChatHistoryPopover(() => {
			setIsOpen(true);
			chatThreadsService.pullChatHistoryPopoverPending();
		});
		return () => d.dispose();
	}, [chatThreadsService]);

	useEffect(() => {
		if (!isOpen) {
			setFilter('');
		}
	}, [isOpen]);

	const measureRef = useRef<HTMLDivElement | null>(null);

	const {
		x,
		y,
		strategy,
		refs,
		update,
	} = useFloating({
		open: isOpen,
		onOpenChange: setIsOpen,
		placement: 'bottom-start',
		middleware: [
			offset({ mainAxis: 4, crossAxis: -6 }),
			flip({ boundary: document.body, padding: 8 }),
			shift({ boundary: document.body, padding: 8 }),
			size({
				apply({ availableHeight, elements, rects }) {
					const maxHeight = Math.max(160, Math.min(availableHeight - 12, 400));
					Object.assign(elements.floating.style, {
						maxHeight: `${maxHeight}px`,
						maxWidth: 'min(90vw, 360px)',
						overflow: 'hidden',
						display: 'flex',
						flexDirection: 'column',
						minWidth: '280px',
						width: `${Math.max(
							280,
							rects.reference.width,
							measureRef.current?.offsetWidth ?? 280
						)}px`,
					});
				},
				padding: 8,
				boundary: document.body,
			}),
		],
		whileElementsMounted: autoUpdate,
		strategy: 'fixed',
	});

	useLayoutEffect(() => {
		if (!isOpen) {
			return;
		}
		void update();
	}, [isOpen, update, filteredIds.length]);

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Node;
			const floating = refs.floating.current;
			const reference = refs.reference.current;
			const isReferenceHTMLElement = reference && 'contains' in reference;
			if (
				floating &&
				(!isReferenceHTMLElement || !reference.contains(target)) &&
				!floating.contains(target)
			) {
				setIsOpen(false);
			}
		};
		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [isOpen, refs.floating, refs.reference]);

	const { allThreads } = threadsState;
	if (!allThreads) {
		return null;
	}

	return (
		<div className={`inline-flex relative shrink-0 ${className ?? ''}`}>
			<button
				type="button"
				ref={refs.setReference}
				className="flex items-center gap-0.5 h-full min-h-[18px] bg-transparent whitespace-nowrap hover:brightness-90"
				title={chatS.historyToolbarTitle}
				aria-label={chatS.historyToolbarTitle}
				aria-expanded={isOpen}
				onClick={() => setIsOpen(v => !v)}
			>
				<History size={13} className="text-vibe-fg-3 shrink-0" />
				<svg className="size-3 shrink-0 text-vibe-fg-3" viewBox="0 0 12 12" fill="none">
					<path
						d="M2.5 4.5L6 8L9.5 4.5"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			{isOpen ? (
				<div
					ref={refs.setFloating}
					className="z-[10000] bg-vibe-bg-1 @@vibe-popup-panel rounded-xl shadow-lg overflow-hidden"
					style={{ position: strategy, top: y ?? 0, left: x ?? 0 }}
				>
					<div className="px-2 py-1.5 border-b border-vibe-border-2 shrink-0 flex flex-col gap-1.5">
						<input
							type="search"
							autoFocus
							value={filter}
							onChange={e => setFilter(e.target.value)}
							onKeyDown={e => e.stopPropagation()}
							placeholder={chatS.historyFilterPlaceholder}
							className="w-full text-xs px-2 py-1 rounded-lg bg-vibe-bg-2 text-vibe-fg-2 border border-vibe-border-2 outline-none placeholder:text-vibe-fg-4"
						/>
						{otherProjectsCount > 0 && (
							<div className="flex justify-end">
								<HistoryScopeToggle showAll={showAll} setShowAll={setShowAll} otherCount={otherProjectsCount} />
							</div>
						)}
					</div>
					<div
						ref={measureRef}
						className="overflow-y-auto min-h-0 flex-1 px-1 py-1 flex flex-col gap-1"
						style={{ maxHeight: 'min(320px, 70vh)' }}
					>
						{otherMatchesCount > 0 && (
							<button
								type="button"
								className="w-full text-left px-2 py-1.5 text-[11px] text-vibe-fg-3 hover:text-vibe-fg-1 hover:bg-vibe-bg-3 rounded-lg transition-colors select-none"
								onClick={() => setShowAll(true)}
							>
								{chatS.historyOtherMatches(otherMatchesCount)}
							</button>
						)}
						{filteredIds.length === 0 ? (
							<div className="text-xs text-vibe-fg-4 px-2 py-2">{chatS.historyEmptyFiltered}</div>
						) : (
							filteredIds.map((threadId, i) => {
								const pastThread = allThreads[threadId];
								if (!pastThread) {
									return null;
								}
								return (
									<PastThreadElement
										key={pastThread.id}
										pastThread={pastThread}
										idx={i}
										hoveredIdx={hoveredIdx}
										setHoveredIdx={setHoveredIdx}
										isRunning={runningThreadIds[pastThread.id]}
										onAfterSwitch={close}
										scope={{ showAll, currentWorkspaceId: wsId }}
									/>
								);
							})
						)}
					</div>
				</div>
			) : null}
		</div>
	);
};
