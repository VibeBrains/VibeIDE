/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useFloating, autoUpdate, offset, flip, shift, size } from '@floating-ui/react';
import { URI } from '../../../../../../../base/common/uri.js';
import { useAccessor, useChatJournal } from '../util/services.js';
import { chatS } from '../vibe-settings-tsx/vibeSettingsRu.js';
import {
	ChatJournalAction,
	ChatJournalCategory,
	ChatJournalEntry,
	ChatJournalPathRef,
	chatJournalSpansOf,
	countChatJournalByCategory,
	filterChatJournal,
	previewChatJournalText,
	summarizeChatJournal,
} from '../../../../common/chatJournal.js';
import { CHAT_TIMESTAMP_TOOLTIP_PATTERN, CHAT_JOURNAL_TIME_PATTERN, chatTimestampToISO, formatChatTimestamp } from '../../../../common/chatTimestampFormatter.js';

/** The widest the panel gets; in a narrow chat it takes the width of the chat column instead */
const PANEL_MAX_WIDTH_PX = 420;
const PANEL_MAX_HEIGHT_PX = 480;
/** Room left between the panel and the edge of the chat column */
const PANEL_EDGE_GAP_PX = 8;

/** One empty set for every reset: a state set to the set it already holds does not render again */
const NO_ITEMS: ReadonlySet<never> = new Set();

const JournalActionButton = ({ action, onRun }: { action: ChatJournalAction; onRun: (action: ChatJournalAction) => void }) => {
	const label = action.kind === 'openSetting' ? chatS.journalOpenSetting : action.kind === 'openFile' ? chatS.journalOpenFile : action.label;
	const title = action.kind === 'openSetting' ? action.settingId : undefined;
	return (
		<button type='button' className='@@vibe-journal-action' title={title} onClick={() => onRun(action)}>{label}</button>
	);
};

/**
 * A file path of the text, shown as its short name with the full path in the tooltip (the global `vibe-tooltip` of the chat)
 * The name is a link only when the file exists: the check is asynchronous, so a path starts as plain text
 */
const JournalFilePath = ({ pathRef, onRun }: { pathRef: ChatJournalPathRef; onRun: (action: ChatJournalAction) => void }) => {
	const fileService = useAccessor().get('IFileService');
	const uri = useMemo(() => URI.file(pathRef.path), [pathRef.path]);
	const [isFile, setIsFile] = useState(false);
	useEffect(() => {
		let isCurrent = true;
		setIsFile(false);
		fileService.stat(uri).then(stat => { if (isCurrent) { setIsFile(stat.isFile); } }, () => { /* a missing or unreadable file stays plain text */ });
		return () => { isCurrent = false; };
	}, [fileService, uri]);

	const tooltip = { 'data-tooltip-id': 'vibe-tooltip', 'data-tooltip-content': pathRef.path, 'data-tooltip-place': 'top' } as const;
	if (!isFile) {
		return <span className='@@vibe-journal-path' {...tooltip}>{pathRef.label}</span>;
	}
	return (
		<button
			type='button'
			className='@@vibe-journal-path @@vibe-journal-path-link'
			{...tooltip}
			onClick={() => onRun({ kind: 'openFile', resource: uri.toString() })}
		>{pathRef.label}</button>
	);
};

const JournalEntryRow = ({ entry, isFresh, onRun }: { entry: ChatJournalEntry; isFresh: boolean; onRun: (action: ChatJournalAction) => void }) => {
	const [expanded, setExpanded] = useState(false);
	const preview = useMemo(() => previewChatJournalText(entry.text), [entry.text]);
	// The names are made unique within the whole text, so a path keeps its name when the entry is expanded
	const spans = useMemo(() => chatJournalSpansOf(expanded ? entry.text : preview.text, entry.text), [expanded, entry.text, preview.text]);
	const isWarning = entry.level === 'warning';
	return (
		<li className={`@@vibe-journal-entry ${isWarning ? '@@vibe-journal-entry-warning' : ''} ${isFresh ? '@@vibe-journal-entry-fresh' : ''}`}>
			<span
				className={`@@codicon ${isWarning ? '@@codicon-warning @@vibe-journal-icon-warning' : '@@codicon-info @@vibe-journal-icon-info'}`}
				role='img'
				aria-label={isWarning ? chatS.journalLevelWarning : chatS.journalLevelInfo}
				title={isWarning ? chatS.journalLevelWarning : chatS.journalLevelInfo}
			/>
			<div className='min-w-0 flex flex-col gap-1'>
				<div className='flex items-center gap-1.5 text-[11px] text-vibe-fg-3 select-none'>
					<time dateTime={chatTimestampToISO(entry.at)} title={formatChatTimestamp(entry.at, CHAT_TIMESTAMP_TOOLTIP_PATTERN)}>
						{formatChatTimestamp(entry.at, CHAT_JOURNAL_TIME_PATTERN)}
					</time>
					<span className='@@vibe-journal-category'>{chatS.journalCategory[entry.category]}</span>
					{entry.count > 1 && <span className='@@vibe-journal-repeat' title={chatS.journalRepeated(entry.count)}>×{entry.count}</span>}
					{isFresh && <span className='@@vibe-journal-fresh-dot' title={chatS.journalNew} />}
				</div>
				<div className='@@vibe-journal-text text-[12px] text-vibe-fg-1'>
					{spans.map((span, i) => {
						const content = span.path ? <JournalFilePath pathRef={span.path} onRun={onRun} /> : span.text;
						return span.style === 'bold'
							? <strong key={i}>{content}</strong>
							: span.style === 'code'
								? <code key={i} className='@@vibe-journal-code'>{content}</code>
								: <span key={i}>{content}</span>;
					})}
				</div>
				{(preview.truncated || entry.actions?.length) ? (
					<div className='flex flex-wrap items-center gap-1.5'>
						{preview.truncated && (
							<button type='button' className='@@vibe-journal-action' aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
								{expanded ? chatS.journalShowLess : chatS.journalShowAll}
							</button>
						)}
						{entry.actions?.map((action, i) => <JournalActionButton key={i} action={action} onRun={onRun} />)}
					</div>
				) : null}
			</div>
		</li>
	);
};

/**
 * The journal of the chat: a button in the header with the count of unread entries and the panel it opens
 *
 * The panel hangs under the button, over the chat, and is not modal:
 * it takes no focus, closes on Escape, on a click elsewhere and on a second click on the button
 * Opening it reads everything, and what arrives while it is open is read at once
 */
export const ChatJournalButton = ({ boundaryRef }: { boundaryRef: React.RefObject<HTMLElement | null> }) => {
	const accessor = useAccessor();
	const journal = accessor.get('IChatJournalService');
	const commandService = accessor.get('ICommandService');
	const editorService = accessor.get('IEditorService');
	const entries = useChatJournal();
	const summary = useMemo(() => summarizeChatJournal(entries), [entries]);

	const [isOpen, setIsOpen] = useState(false);
	const [categories, setCategories] = useState<ReadonlySet<ChatJournalCategory>>(NO_ITEMS);
	const [onlyWarnings, setOnlyWarnings] = useState(false);
	// The entries that were unread when the panel showed them: the mark outlives the read flag until the panel closes
	const [freshIds, setFreshIds] = useState<ReadonlySet<number>>(NO_ITEMS);

	const { x, y, strategy, refs, update } = useFloating({
		open: isOpen,
		onOpenChange: setIsOpen,
		placement: 'bottom-end',
		middleware: [
			offset(4),
			flip({ boundary: document.body, padding: PANEL_EDGE_GAP_PX }),
			// The panel stays inside the chat column: the button is not at the right edge of the header, so the panel would reach over the editor
			shift(() => ({ boundary: boundaryRef.current ?? document.body, padding: PANEL_EDGE_GAP_PX })),
			size({
				apply({ availableHeight, elements }) {
					const columnWidth = boundaryRef.current?.clientWidth ?? PANEL_MAX_WIDTH_PX;
					Object.assign(elements.floating.style, {
						maxHeight: `${Math.max(180, Math.min(availableHeight - PANEL_EDGE_GAP_PX, PANEL_MAX_HEIGHT_PX))}px`,
						width: `${Math.min(PANEL_MAX_WIDTH_PX, columnWidth - 2 * PANEL_EDGE_GAP_PX)}px`,
					});
				},
				padding: PANEL_EDGE_GAP_PX,
				boundary: document.body,
			}),
		],
		whileElementsMounted: autoUpdate,
		strategy: 'fixed',
	});

	const close = useCallback(() => setIsOpen(false), []);

	useEffect(() => {
		if (isOpen) { return; }
		setFreshIds(NO_ITEMS);
		setCategories(NO_ITEMS);
		setOnlyWarnings(false);
	}, [isOpen]);

	useEffect(() => {
		if (!isOpen) { return; }
		const unread = entries.filter(entry => !entry.read);
		if (unread.length === 0) { return; }
		setFreshIds(prev => new Set([...prev, ...unread.map(entry => entry.id)]));
		journal.markAllRead();
	}, [isOpen, entries, journal]);

	useLayoutEffect(() => {
		if (isOpen) { void update(); }
	}, [isOpen, update, entries.length]);

	useEffect(() => {
		if (!isOpen) { return; }
		// Escape in the capture phase: the same key aborts a running answer from the input field, and here it only closes the panel
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') { return; }
			event.preventDefault();
			event.stopPropagation();
			setIsOpen(false);
		};
		const onMouseDown = (event: MouseEvent) => {
			const target = event.target as Node;
			if (refs.floating.current?.contains(target) || (refs.reference.current as Element | null)?.contains(target)) { return; }
			setIsOpen(false);
		};
		document.addEventListener('keydown', onKeyDown, true);
		document.addEventListener('mousedown', onMouseDown);
		return () => {
			document.removeEventListener('keydown', onKeyDown, true);
			document.removeEventListener('mousedown', onMouseDown);
		};
	}, [isOpen, refs.floating, refs.reference]);

	const runAction = useCallback((action: ChatJournalAction) => {
		switch (action.kind) {
			case 'openSetting':
				void commandService.executeCommand('workbench.action.openSettings', action.settingId);
				break;
			case 'openFile':
				void editorService.openEditor({ resource: URI.parse(action.resource) });
				break;
			case 'command':
				void commandService.executeCommand(action.commandId, ...(action.args ?? []));
				break;
		}
		setIsOpen(false);
	}, [commandService, editorService]);

	const toggleCategory = useCallback((category: ChatJournalCategory) => {
		setCategories(prev => {
			const next = new Set(prev);
			if (!next.delete(category)) { next.add(category); }
			return next;
		});
	}, []);

	const categoryCounts = useMemo(() => countChatJournalByCategory(entries), [entries]);
	const visible = useMemo(() => filterChatJournal(entries, { categories, onlyWarnings }), [entries, categories, onlyWarnings]);

	const badge = summary.unread > 0 ? (summary.unread > 99 ? '99+' : String(summary.unread)) : null;
	const title = chatS.journalButtonTitle(summary.unread);

	return (
		<div className='inline-flex shrink-0'>
			<button
				type='button'
				ref={refs.setReference}
				className={`@@vibe-journal-button shrink-0 px-1 py-0.5 rounded text-vibe-fg-3 hover:text-vibe-fg-1 hover:bg-vibe-bg-3 ${summary.total === 0 ? 'opacity-50' : ''}`}
				title={title}
				aria-label={title}
				aria-haspopup='dialog'
				aria-expanded={isOpen}
				onClick={() => setIsOpen(v => !v)}
			>
				<span className='@@codicon @@codicon-output' aria-hidden='true' />
				{badge && <span className={`@@vibe-journal-badge ${summary.hasUnreadWarning ? '@@vibe-journal-badge-warning' : ''}`}>{badge}</span>}
			</button>
			{isOpen && (
				<div
					ref={refs.setFloating}
					role='dialog'
					aria-label={chatS.journalTitle}
					className='@@vibe-journal-panel z-[10000] bg-vibe-bg-1 @@vibe-popup-panel rounded-xl shadow-lg overflow-hidden flex flex-col'
					style={{ position: strategy, top: y ?? 0, left: x ?? 0 }}
				>
					<div className='flex items-center gap-2 px-2.5 py-1.5 border-b border-vibe-border-2 shrink-0'>
						<span className='text-[11px] font-semibold uppercase tracking-widest text-vibe-fg-3 select-none'>{chatS.journalTitle}</span>
						<span className='flex-1' />
						<button
							type='button'
							className='@@vibe-journal-action'
							title={chatS.journalClearTitle}
							disabled={entries.length === 0}
							onClick={() => { journal.clear(); setCategories(NO_ITEMS); setOnlyWarnings(false); setFreshIds(NO_ITEMS); }}
						>{chatS.journalClear}</button>
						<button
							type='button'
							className='@@vibe-journal-close'
							title={chatS.journalClose}
							aria-label={chatS.journalClose}
							onClick={close}
						><span className='@@codicon @@codicon-close' aria-hidden='true' /></button>
					</div>
					{entries.length > 0 && (
						<div className='flex flex-wrap items-center gap-1 px-2.5 py-1.5 border-b border-vibe-border-2 shrink-0' role='group' aria-label={chatS.journalFilterAria}>
							{categoryCounts.map(({ category, count }) => (
								<button
									key={category}
									type='button'
									className='@@vibe-journal-chip'
									aria-pressed={categories.has(category)}
									onClick={() => toggleCategory(category)}
								>{chatS.journalCategory[category]} {count}</button>
							))}
							<button
								type='button'
								className='@@vibe-journal-chip @@vibe-journal-chip-warning'
								aria-pressed={onlyWarnings}
								onClick={() => setOnlyWarnings(v => !v)}
							><span className='@@codicon @@codicon-warning' aria-hidden='true' /> {chatS.journalOnlyWarnings}</button>
						</div>
					)}
					<ul className='m-0 p-0 list-none overflow-y-auto @@vibe-scroll min-h-0 flex-1'>
						{visible.map(entry => (
							<JournalEntryRow key={entry.id} entry={entry} isFresh={freshIds.has(entry.id)} onRun={runAction} />
						))}
					</ul>
					{visible.length === 0 && (
						<div className='text-xs text-vibe-fg-4 px-3 py-3'>{entries.length === 0 ? chatS.journalEmpty : chatS.journalEmptyFiltered}</div>
					)}
				</div>
			)}
		</div>
	);
};
