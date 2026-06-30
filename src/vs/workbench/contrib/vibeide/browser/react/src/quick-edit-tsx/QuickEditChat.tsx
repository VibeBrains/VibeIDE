/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSettingsState, useAccessor, useCtrlKZoneStreamingState } from '../util/services.js';
import { TextAreaFns, VibeInputBox2 } from '../util/inputs.js';
import { QuickEditPropsType } from '../../../quickEditActions.js';
import { ButtonStop, ButtonSubmit, IconX, VibeChatArea } from '../sidebar-tsx/SidebarChat.js';
import { VIBEIDE_CTRL_K_ACTION_ID } from '../../../actionIDs.js';
import { useRefState } from '../util/helpers.js';
import { isFeatureNameDisabled } from '../../../../../../../workbench/contrib/vibeide/common/vibeideSettingsTypes.js';
import { quickEditS } from '../vibe-settings-tsx/vibeSettingsRu.js';
import { expandQuickEditSlashCommand, quickEditSlashHintNames } from '../../../../common/quickEditTemplates.js';
import { appendPromptToHistory, navigateHistory, QUICK_EDIT_HISTORY_DEFAULT_MAX } from '../../../../common/quickEditPromptHistory.js';

// Module-level history singleton — persists across QuickEdit zone instances
// within the same window session. (Wave-3: lift to IStorageService for
// cross-session persistence.) Hydrated from `quickEditHistory` global if
// the host injected one at startup; otherwise starts empty.
const HISTORY_GLOBAL_KEY = '__vibeQuickEditHistory';
const __win = typeof globalThis !== 'undefined' ? (globalThis as Record<string, unknown>) : {};
let quickEditHistory: string[] = Array.isArray(__win[HISTORY_GLOBAL_KEY])
	? (__win[HISTORY_GLOBAL_KEY] as string[]).slice()
	: [];
const persistHistory = () => { __win[HISTORY_GLOBAL_KEY] = quickEditHistory.slice(); };




export const QuickEditChat = ({
	diffareaid,
	onChangeHeight,
	onChangeText: onChangeText_,
	textAreaRef: textAreaRef_,
	initText
}: QuickEditPropsType) => {

	const accessor = useAccessor();
	const editCodeService = accessor.get('IEditCodeService');
	const sizerRef = useRef<HTMLDivElement | null>(null);
	const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
	const textAreaFnsRef = useRef<TextAreaFns | null>(null);

	useEffect(() => {
		const inputContainer = sizerRef.current;
		if (!inputContainer) {return;}
		// only observing 1 element
		const resizeObserver = new ResizeObserver((entries) => {
			const height = entries[0].borderBoxSize[0].blockSize;
			onChangeHeight(height);
		});
		resizeObserver.observe(inputContainer);
		return () => { resizeObserver?.disconnect(); };
	}, [onChangeHeight]);


	const settingsState = useSettingsState();

	// state of current message
	const [instructionsAreEmpty, setInstructionsAreEmpty] = useState(!(initText ?? '')); // the user's instructions
	const isDisabled = instructionsAreEmpty || !!isFeatureNameDisabled('Ctrl+K', settingsState);


	const [isStreamingRef, setIsStreamingRef] = useRefState(editCodeService.isCtrlKZoneStreaming({ diffareaid }));
	useCtrlKZoneStreamingState(useCallback((diffareaid2, isStreaming) => {
		if (diffareaid !== diffareaid2) {return;}
		setIsStreamingRef(isStreaming);
	}, [diffareaid, setIsStreamingRef]));

	const loadingIcon = <div
		className="@@codicon @@codicon-loading @@codicon-modifier-spin @@codicon-no-default-spin text-vibe-fg-3"
	/>;

	// ↑/↓ history navigation state. `historyIndex === quickEditHistory.length`
	// means "current editing position, not yet in history".
	const historyIndexRef = useRef<number>(quickEditHistory.length);
	const draftBeforeHistoryRef = useRef<string>('');

	const onSubmit = useCallback(async () => {
		if (isDisabled) {return;}
		if (isStreamingRef.current) {return;}

		// Slash-command expansion (R.1): rewrite the textarea value to the full
		// template before the existing startApplying pipeline reads it.
		const currentValue = textAreaRef.current?.value ?? '';
		const expansion = expandQuickEditSlashCommand(currentValue);
		if (expansion.matched) {
			textAreaFnsRef.current?.setValue(expansion.expanded);
		}
		// Save the raw (pre-expansion) prompt to history so ↑ replays what the
		// user typed, not the expanded template.
		quickEditHistory = appendPromptToHistory(quickEditHistory, currentValue, QUICK_EDIT_HISTORY_DEFAULT_MAX);
		historyIndexRef.current = quickEditHistory.length;
		draftBeforeHistoryRef.current = '';
		persistHistory();

		textAreaFnsRef.current?.disable();

		const opts = {
			from: 'QuickEdit',
			diffareaid,
			startBehavior: 'keep-conflicts',
		} as const;

		await editCodeService.callBeforeApplyOrEdit(opts);
		const [newApplyingUri, applyDonePromise] = editCodeService.startApplying(opts) ?? [];
		// catch any errors by interrupting the stream
		applyDonePromise?.catch(e => { if (newApplyingUri) {editCodeService.interruptCtrlKStreaming({ diffareaid });} });


	}, [isStreamingRef, isDisabled, editCodeService, diffareaid]);

	const onClickSlashChip = useCallback((cmdName: string) => {
		if (isStreamingRef.current) {return;}
		textAreaFnsRef.current?.setValue(`${cmdName} `);
		textAreaRef.current?.focus();
	}, [isStreamingRef]);

	const onInterrupt = useCallback(() => {
		if (!isStreamingRef.current) {return;}
		editCodeService.interruptCtrlKStreaming({ diffareaid });
		textAreaFnsRef.current?.enable();
	}, [isStreamingRef, editCodeService]);


	const onX = useCallback(() => {
		onInterrupt();
		editCodeService.removeCtrlKZone({ diffareaid });
	}, [editCodeService, diffareaid]);

	const keybindingString = accessor.get('IKeybindingService').lookupKeybinding(VIBEIDE_CTRL_K_ACTION_ID)?.getLabel();

	const chatAreaRef = useRef<HTMLDivElement | null>(null);
	return <div ref={sizerRef} style={{ maxWidth: 450 }} className={`py-2 w-full`}>
		<VibeChatArea
			featureName='Ctrl+K'
			divRef={chatAreaRef}
			onSubmit={onSubmit}
			onAbort={onInterrupt}
			onClose={onX}
			isStreaming={isStreamingRef.current}
			loadingIcon={loadingIcon}
			isDisabled={isDisabled}
			onClickAnywhere={() => { textAreaRef.current?.focus(); }}
		>
			{instructionsAreEmpty && (
				<div className='flex flex-wrap items-center gap-1 px-1 pb-1 text-[10px] text-vibe-fg-3 select-none'>
					<span className='opacity-70 mr-0.5'>{quickEditS.slashHintRow}</span>
					{quickEditSlashHintNames(5).map(cmd => (
						<button
							key={cmd}
							type='button'
							className='px-1.5 py-0.5 rounded border border-vibe-border-1 hover:bg-vibe-bg-3 hover:text-vibe-fg-1 transition-colors font-mono'
							onClick={() => onClickSlashChip(cmd)}
							title={`Insert ${cmd}`}
						>
							{cmd}
						</button>
					))}
				</div>
			)}
			<VibeInputBox2
				className='px-1'
				initValue={initText}
				highlightSlashCommands={true}
				ref={useCallback((r: HTMLTextAreaElement | null) => {
					textAreaRef.current = r;
					textAreaRef_(r);
					r?.addEventListener('keydown', (e) => {
						if (e.key === 'Escape')
							{onX();}
					});
				}, [textAreaRef_, onX])}
				fnsRef={textAreaFnsRef}
				placeholder={quickEditS.placeholder}
				onChangeText={useCallback((newStr: string) => {
					setInstructionsAreEmpty(!newStr);
					onChangeText_(newStr);
				}, [onChangeText_])}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						onSubmit();
						return;
					}
					// ↑/↓ history navigation — only when textarea is single-line-y
					// (no embedded newlines) so multiline editing isn't hijacked.
					if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
						const ta = textAreaRef.current;
						if (!ta || ta.value.includes('\n')) {return;}
						if (quickEditHistory.length === 0) {return;}
						const direction: -1 | 1 = e.key === 'ArrowUp' ? -1 : 1;
						// On first ↑ from present, stash current draft so ↓-past-newest restores it.
						if (historyIndexRef.current === quickEditHistory.length && direction === -1) {
							draftBeforeHistoryRef.current = ta.value;
						}
						const step = navigateHistory(quickEditHistory, historyIndexRef.current, direction);
						if (step.value === null) {return;} // no further in that direction
						e.preventDefault();
						historyIndexRef.current = step.newIndex;
						const newValue = step.value === '' ? draftBeforeHistoryRef.current : step.value;
						textAreaFnsRef.current?.setValue(newValue);
						// Move cursor to end.
						requestAnimationFrame(() => { ta.setSelectionRange(newValue.length, newValue.length); });
					}
				}}
				multiline={true}
			/>
		</VibeChatArea>
	</div>;


};
