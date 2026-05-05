/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useMemo, useState, useCallback, useLayoutEffect, useEffect, useRef } from 'react';
import { useFloating, autoUpdate, offset, flip, shift, size } from '@floating-ui/react';
import { chatS } from '../vibe-settings-tsx/vibeSettingsRu.js';
import { IconShell1 } from '../markdown/ApplyBlockHoverButtons.js';
import { useAccessor, useChatThreadsState, useFullChatThreadsStreamState } from '../util/services.js';
import { IconX } from './SidebarChat.js';
import { Check, Copy, LoaderCircle, MessageCircleQuestion, Trash2, History, X } from 'lucide-react';
import { IsRunningType, ThreadType } from '../../../chatThreadService.js';


const numInitialThreads = 3

export const PastThreadsList = ({ className = '' }: { className?: string }) => {
	const [showAll, setShowAll] = useState(false);

	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

	const threadsState = useChatThreadsState()
	const { allThreads } = threadsState

	const streamState = useFullChatThreadsStreamState()

	// Memoize runningThreadIds computation to avoid recalculating on every render
	const runningThreadIds = useMemo(() => {
		const result: { [threadId: string]: IsRunningType | undefined } = {}
		for (const threadId in streamState) {
			const isRunning = streamState[threadId]?.isRunning
			if (isRunning) { result[threadId] = isRunning }
		}
		return result
	}, [streamState])

	if (!allThreads) {
		return <div key="error" className="p-1">{`Error accessing chat history.`}</div>;
	}

	// Memoize sortedThreadIds computation to avoid recalculating on every render
	const sortedThreadIds = useMemo(() => {
		return Object.keys(allThreads ?? {})
			.sort((threadId1, threadId2) => (allThreads[threadId1]?.lastModified ?? 0) > (allThreads[threadId2]?.lastModified ?? 0) ? -1 : 1)
			.filter(threadId => (allThreads![threadId]?.messages.length ?? 0) !== 0)
	}, [allThreads])

	// Get only first 5 threads if not showing all
	const hasMoreThreads = sortedThreadIds.length > numInitialThreads;
	const displayThreads = showAll ? sortedThreadIds : sortedThreadIds.slice(0, numInitialThreads);

	return (
		<div className={`flex flex-col mb-2 gap-2 w-full text-nowrap text-vibe-fg-2 select-none relative ${className}`}>
			{displayThreads.length === 0 // this should never happen
				? <></>
				: displayThreads.map((threadId, i) => {
					const pastThread = allThreads[threadId];
					if (!pastThread) {
						return <div key={i} className="p-1">{`Error accessing chat history.`}</div>;
					}

					return (
						<PastThreadElement
							key={pastThread.id}
							pastThread={pastThread}
							idx={i}
							hoveredIdx={hoveredIdx}
							setHoveredIdx={setHoveredIdx}
							isRunning={runningThreadIds[pastThread.id]}
						/>
					);
				})
			}

			{hasMoreThreads && !showAll && (
				<div
					className="text-vibe-fg-3 opacity-80 hover:opacity-100 hover:brightness-115 cursor-pointer p-1 text-xs"
					onClick={() => setShowAll(true)}
				>
					Show {sortedThreadIds.length - numInitialThreads} more...
				</div>
			)}
			{hasMoreThreads && showAll && (
				<div
					className="text-vibe-fg-3 opacity-80 hover:opacity-100 hover:brightness-115 cursor-pointer p-1 text-xs"
					onClick={() => setShowAll(false)}
				>
					Show less
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
	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')
	return <IconShell1
		Icon={Copy}
		className='size-[11px]'
		onClick={() => { chatThreadsService.duplicateThread(threadId); }}
		data-tooltip-id='vibe-tooltip'
		data-tooltip-place='top'
		data-tooltip-content='Duplicate thread'
	>
	</IconShell1>

}

const TrashButton = ({ threadId }: { threadId: string }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')


	const [isTrashPressed, setIsTrashPressed] = useState(false)

	return (isTrashPressed ?
		<div className='flex flex-nowrap text-nowrap gap-1'>
			<IconShell1
				Icon={X}
				className='size-[11px]'
				onClick={() => { setIsTrashPressed(false); }}
				data-tooltip-id='vibe-tooltip'
				data-tooltip-place='top'
				data-tooltip-content='Cancel'
			/>
			<IconShell1
				Icon={Check}
				className='size-[11px]'
				onClick={() => { chatThreadsService.deleteThread(threadId); setIsTrashPressed(false); }}
				data-tooltip-id='vibe-tooltip'
				data-tooltip-place='top'
				data-tooltip-content='Confirm'
			/>
		</div>
		: <IconShell1
			Icon={Trash2}
			className='size-[11px]'
			onClick={() => { setIsTrashPressed(true); }}
			data-tooltip-id='vibe-tooltip'
			data-tooltip-place='top'
			data-tooltip-content='Delete thread'
		/>
	)
}

const PastThreadElement = ({
	pastThread,
	idx,
	hoveredIdx,
	setHoveredIdx,
	isRunning,
	onAfterSwitch,
}: {
	pastThread: ThreadType,
	idx: number,
	hoveredIdx: number | null,
	setHoveredIdx: (idx: number | null) => void,
	isRunning: IsRunningType | undefined,
	onAfterSwitch?: () => void,
}) => {


	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

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
		<span className='inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-vibe-bg-2 text-[10px] tracking-wide uppercase text-vibe-fg-3'>
			<span>{numMessages} msg</span>
			<span className='opacity-80'>{formatDate(new Date(pastThread.lastModified))}</span>
		</span>
	)

	return <div
		key={pastThread.id}
		className={`
			group px-3 py-2 rounded-2xl @@chat-composer-shell cursor-pointer text-sm text-vibe-fg-1 transition-colors duration-150 ease-out
		`}
		onClick={() => {
			chatThreadsService.switchToThread(pastThread.id);
			onAfterSwitch?.();
		}}
		onMouseEnter={() => setHoveredIdx(idx)}
		onMouseLeave={() => setHoveredIdx(null)}
	>
		<div className="flex items-center justify-between gap-2">
			<span className="flex items-center gap-2 min-w-0 overflow-hidden text-vibe-fg-2">
                {/* status icon */}
                {isRunning === 'LLM' || isRunning === 'tool' || isRunning === 'preparing' ? (
                    <LoaderCircle className="animate-spin text-vibe-fg-1 flex-shrink-0 flex-grow-0" size={14} />
                ) : isRunning === 'awaiting_user' ? (
                    <MessageCircleQuestion className="text-vibe-fg-1 flex-shrink-0 flex-grow-0" size={14} />
                ) : null}
				{/* name */}
				<span className="truncate overflow-hidden text-ellipsis text-vibe-fg-1"
					data-tooltip-id='vibe-tooltip'
					data-tooltip-content={numMessages + ' messages'}
					data-tooltip-place='top'
				>{firstMsg}</span>

				{/* <span className='opacity-60'>{`(${numMessages})`}</span> */}
			</span>

			<div className="flex items-center gap-x-1 opacity-80 text-vibe-fg-3">
				{idx === hoveredIdx ?
					<>
						{/* duplicate */}
						<DuplicateButton threadId={pastThread.id} />

						{/* trash icon */}
						<TrashButton threadId={pastThread.id} />
					</>
					: <>
						<div className="opacity-90">{detailsHTML}</div>
					</>
				}
			</div>
		</div>
	</div>;
};


/** Composer toolbar control: anchored popover listing past threads (same pattern as ChatModeDropdown). */
export const ChatHistoryToolbarDropdown: React.FC<{ className?: string }> = ({ className }) => {
	const accessor = useAccessor();
	const threadsState = useChatThreadsState();
	const streamState = useFullChatThreadsStreamState();
	const chatThreadsService = accessor.get('IChatThreadService');

	const [isOpen, setIsOpen] = useState(false);
	const [filter, setFilter] = useState('');
	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

	const sortedThreadIds = useMemo(() => {
		const { allThreads } = threadsState;
		if (!allThreads) {
			return [];
		}
		return Object.keys(allThreads)
			.sort((a, b) => (allThreads[a]?.lastModified ?? 0) > (allThreads[b]?.lastModified ?? 0) ? -1 : 1)
			.filter(id => (allThreads[id]?.messages.length ?? 0) !== 0);
	}, [threadsState]);

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
					className="z-[10000] bg-vibe-bg-1 border-vibe-border-3 border rounded-xl shadow-lg overflow-hidden"
					style={{ position: strategy, top: y ?? 0, left: x ?? 0 }}
				>
					<div className="px-2 py-1.5 border-b border-vibe-border-2 shrink-0">
						<input
							type="search"
							autoFocus
							value={filter}
							onChange={e => setFilter(e.target.value)}
							onKeyDown={e => e.stopPropagation()}
							placeholder={chatS.historyFilterPlaceholder}
							className="w-full text-xs px-2 py-1 rounded-lg bg-vibe-bg-2 text-vibe-fg-2 border border-vibe-border-2 outline-none placeholder:text-vibe-fg-4"
						/>
					</div>
					<div
						ref={measureRef}
						className="overflow-y-auto min-h-0 flex-1 px-1 py-1 flex flex-col gap-1"
						style={{ maxHeight: 'min(320px, 70vh)' }}
					>
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
