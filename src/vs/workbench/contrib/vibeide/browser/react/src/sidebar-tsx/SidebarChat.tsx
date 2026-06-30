/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import React, { ButtonHTMLAttributes, FormEvent, FormHTMLAttributes, Fragment, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';


import { useAccessor, useChatThreadsState, useChatThreadsStreamState, useSettingsState, useActiveURI, useCommandBarState, useFullChatThreadsStreamState } from '../util/services.js';
import { ScrollType } from '../../../../../../../editor/common/editorCommon.js';

import { ChatMarkdownRender, ChatMessageLocation, getApplyBoxId } from '../markdown/ChatMarkdownRender.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../../base/common/buffer.js';
import { threadToMarkdown } from '../../../../common/chatThreadToMarkdown.js';
import { IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { ErrorDisplay } from './ErrorDisplay.js';
import { BlockCode, TextAreaFns, VibeCustomDropdownBox, VibeInputBox2, VibeSlider, VibeSwitch, VibeDiffEditor } from '../util/inputs.js';
import { ModelDropdown, } from '../vibe-settings-tsx/ModelDropdown.js';
import { PastThreadsList, ChatHistoryToolbarDropdown } from './SidebarThreadSelector.js';
import { TokenBudgetInline } from './SidebarHistory.js';
import { VIBEIDE_CTRL_L_ACTION_ID } from '../../../actionIDs.js';
import { VIBEIDE_OPEN_SETTINGS_ACTION_ID } from '../../../vibeideSettingsPane.js';
import { ChatMode, displayInfoOfProviderName, FeatureName, isFeatureNameDisabled, isValidProviderModelSelection, ProviderName, providerNames } from '../../../../../../../workbench/contrib/vibeide/common/vibeideSettingsTypes.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { WarningBox } from '../vibe-settings-tsx/WarningBox.js';
import { getModelCapabilities, getIsReasoningEnabledState, getReservedOutputTokenSpace } from '../../../../common/modelCapabilities.js';
import { AlertTriangle, File, Ban, Check, ChevronRight, ChevronDown, Dot, FileIcon, Pencil, Undo, Undo2, X, Flag, Copy as CopyIcon, Info, CirclePlus, Ellipsis, CircleEllipsis, Folder, ALargeSmall, TypeOutline, Text, Image as ImageIcon, FileText, LoaderCircle, Maximize2, Maximize, Pin, FileDown, RotateCcw, StepForward } from 'lucide-react';
import { ChatMessage, CheckpointEntry, StagingSelectionItem, ToolMessage, PlanMessage, ReviewMessage, PlanStep, StepStatus, PlanApprovalState, ChatImageAttachment, ChatPDFAttachment } from '../../../../common/chatThreadServiceTypes.js';
import { formatChatTimestamp, chatTimestampToISO, CHAT_TIMESTAMP_STREAMING_PLACEHOLDER } from '../../../../common/chatTimestampFormatter.js';
import { BuiltinToolCallParams, BuiltinToolName, ToolName, LintErrorItem, ToolApprovalType, toolApprovalTypes } from '../../../../common/toolsServiceTypes.js';
import { approvalTypeOfBuiltinToolName } from '../../../../common/prompt/tools/index.js';
import { CopyButton, EditToolAcceptRejectButtonsHTML, IconShell1, JumpToFileButton, JumpToTerminalButton, StatusIndicator, StatusIndicatorForApplyButton, useApplyStreamState, useEditToolStreamState } from '../markdown/ApplyBlockHoverButtons.js';
import { IsRunningType, WAITING_FOR_MODEL_RESPONSE_SENTINEL } from '../../../chatThreadService.js';
import { acceptAllBg, acceptBorder, buttonFontSize, buttonTextColor, rejectAllBg, rejectBg, rejectBorder } from '../../../../common/helpers/colors.js';
import { builtinToolNames, isABuiltinToolName, MAX_TERMINAL_INACTIVE_TIME } from '../../../../common/prompt/prompts.js';
import { stripUnclaimedToolTags } from '../../../../common/xmlToolNormalize.js';
import { RawToolCallObj } from '../../../../common/sendLLMMessageTypes.js';
import ErrorBoundary from './ErrorBoundary.js';
import { ToolApprovalTypeSwitch } from '../vibe-settings-tsx/Settings.js';
import { chatDiffCountLabel, chatFilesWithChangesLabel, chatModeDetail, chatModeDisplayName, chatS } from '../vibe-settings-tsx/vibeSettingsRu.js';

import { persistentTerminalNameOfId } from '../../../terminalToolService.js';
import { removeMCPToolNamePrefix } from '../../../../common/mcpServiceTypes.js';
import { trackRenderLoop } from '../util/renderLoopGuard.js';
import { useImageAttachments } from '../util/useImageAttachments.js';
import { usePDFAttachments } from '../util/usePDFAttachments.js';
import { PDFAttachmentList } from '../util/PDFAttachmentList.js';
import { ImageAttachmentList } from '../util/ImageAttachmentList.js';
import { ImageMessageRenderer } from '../util/ImageMessageRenderer.js';
import { PDFMessageRenderer } from '../util/PDFMessageRenderer.js';


const CHAT_MODES: readonly ChatMode[] = ['normal', 'gather', 'plan', 'agent'];

/** Narrow a persisted thread-config string to the `ProviderName` union. */
function isProviderName(value: string): value is ProviderName {
	return (providerNames as readonly string[]).includes(value);
}

/** Narrow a persisted thread-config string to the `ChatMode` union. */
function isChatMode(value: string): value is ChatMode {
	return (CHAT_MODES as readonly string[]).includes(value);
}

export const IconX = ({ size, className = '', ...props }: { size: number; className?: string } & React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			xmlns='http://www.w3.org/2000/svg'
			width={size}
			height={size}
			viewBox='0 0 24 24'
			fill='none'
			stroke='currentColor'
			className={className}
			{...props}
		>
			<path
				strokeLinecap='round'
				strokeLinejoin='round'
				d='M6 18 18 6M6 6l12 12'
			/>
		</svg>
	);
};

// Theme-driven timestamp style — consumes neon-aware tokens declared in vibeide.css.
// Outside the neon theme both vars resolve to inert defaults (no glow, fg-3 color).
const NEON_TIMESTAMP_STYLE: React.CSSProperties = {
	color: 'var(--vibe-neon-timestamp-fg)',
	textShadow: 'var(--vibe-neon-timestamp-glow)',
};

const ChatTimestamp = ({ ts, align, streaming }: { ts: number | undefined; align: 'left' | 'right' | 'inline'; streaming?: boolean }) => {
	const settingsState = useSettingsState();
	if (settingsState.globalSettings.showChatTimestamps === false) {return null;}
	const validTs = typeof ts === 'number' && Number.isFinite(ts);
	// Streaming placeholder: occupies same width as a real timestamp so the surrounding
	// layout does not shift when the first chunk arrives and `ts` becomes valid.
	if (!validTs && !streaming) {return null;}
	const text = validTs ? formatChatTimestamp(ts) : CHAT_TIMESTAMP_STREAMING_PLACEHOLDER;
	// NOTE: the session-token budget warning pulse lives on the SESSION line in the footer
	// (TokenBudgetFooter, SidebarHistory.tsx) — NOT here. Chat timestamps stay neutral.
	const timeNode = validTs
		? <time dateTime={chatTimestampToISO(ts)} title={formatChatTimestamp(ts, 'DD.MM.YYYY HH:mm:ss')} style={NEON_TIMESTAMP_STYLE}>{text}</time>
		: <span aria-hidden='true' style={NEON_TIMESTAMP_STYLE}>{text}</span>;
	if (align === 'inline') {
		return <span className='text-[11px] select-none'><span className='mx-1 opacity-70'>·</span>{timeNode}</span>;
	}
	return <div className={`text-[11px] select-none mt-0.5 px-0.5 ${align === 'right' ? 'text-right' : 'text-left'}`}>
		{timeNode}
	</div>;
};

const IconArrowUp = ({ size, className = '' }: { size: number; className?: string }) => {
	return (
		<svg
			width={size}
			height={size}
			className={className}
			viewBox="0 0 20 20"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				fill="currentColor"
				fillRule="evenodd"
				clipRule="evenodd"
				d="M5.293 9.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L11 7.414V15a1 1 0 11-2 0V7.414L6.707 9.707a1 1 0 01-1.414 0z"
			></path>
		</svg>
	);
};


const IconSquare = ({ size, className = '' }: { size: number; className?: string }) => {
	return (
		<svg
			className={className}
			stroke="currentColor"
			fill="currentColor"
			strokeWidth="0"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<rect x="2" y="2" width="20" height="20" rx="4" ry="4" />
		</svg>
	);
};


export const IconWarning = ({ size, className = '' }: { size: number; className?: string }) => {
	return (
		<svg
			className={className}
			stroke="currentColor"
			fill="currentColor"
			strokeWidth="0"
			viewBox="0 0 16 16"
			width={size}
			height={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M7.56 1h.88l6.54 12.26-.44.74H1.44L1 13.26 7.56 1zM8 2.28L2.28 13H13.7L8 2.28zM8.625 12v-1h-1.25v1h1.25zm-1.25-2V6h1.25v4h-1.25z"
			/>
		</svg>
	);
};


type LoadingState = 'thinking' | 'typing' | 'processing' | 'default';

// Format token count with k/m suffixes for better readability
const formatTokenCount = (count: number): string => {
	if (count >= 1000000) {
		return `${(count / 1000000).toFixed(1)}M`;
	} else if (count >= 1000) {
		return `${(count / 1000).toFixed(1)}k`;
	}
	return count.toString();
};

// Frames are drawn as inline SVG (not characters) so all four glyphs share the same
// 24×24 coordinate system: the dot at (12,12) is exactly the center of the plus, the
// small star adds short diagonals at the same pivot, and the large 8-point star extends
// further out — perfect alignment regardless of host font. Using `currentColor` keeps
// them themed by the parent. Animation flow: dot → plus → small star → large star → loop,
// reading as "growing energy" of the pending operation.
const LOADING_GLYPH_FRAMES: ReadonlyArray<React.ReactNode> = [
	<svg key="dot" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">
		<circle cx="12" cy="12" r="2.5" fill="currentColor" />
	</svg>,
	<svg key="plus" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">
		<line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		<line x1="12" y1="3" x2="12" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
	</svg>,
	<svg key="small-star" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">
		<line x1="6" y1="12" x2="18" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		<line x1="12" y1="6" x2="12" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		<line x1="7.8" y1="7.8" x2="16.2" y2="16.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		<line x1="16.2" y1="7.8" x2="7.8" y2="16.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
	</svg>,
	<svg key="star" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">
		<line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		<line x1="12" y1="3" x2="12" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		<line x1="5.6" y1="5.6" x2="18.4" y2="18.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		<line x1="18.4" y1="5.6" x2="5.6" y2="18.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
	</svg>,
];

export const IconLoading = ({
	className = '',
	showTokenCount,
	state = 'default',
	inline = false
}: {
	className?: string;
	showTokenCount?: number;
	state?: LoadingState;
	inline?: boolean;
}) => {
	const [prevTokenCount, setPrevTokenCount] = useState<number | undefined>(undefined);
	const [shouldPulse, setShouldPulse] = useState(false);

	useEffect(() => {
		if (showTokenCount !== undefined && showTokenCount !== prevTokenCount) {
			setShouldPulse(true);
			setPrevTokenCount(showTokenCount);
			const timer = setTimeout(() => setShouldPulse(false), 300);
			return () => clearTimeout(timer);
		}
	}, [showTokenCount, prevTokenCount]);

	const tokenText = showTokenCount !== undefined
		? ` (${formatTokenCount(showTokenCount)} tokens)`
		: '';

	// Cycle period (ms) per state — divided across the four frames (dot → plus → small-star → star)
	const cyclePeriodMs = state === 'thinking' ? 1000 : state === 'processing' ? 800 : 900;
	const frameDurationMs = Math.round(cyclePeriodMs / LOADING_GLYPH_FRAMES.length);

	const [frameIdx, setFrameIdx] = useState(0);
	useEffect(() => {
		// Honor reduced-motion preference by *slowing* the cycle, not freezing it.
		// A frozen progress indicator reads as "stuck" — worse UX than gentle motion.
		// reduce-motion targets decorative animations (parallax, slide-ins), not status.
		const reduceMotion = typeof window !== 'undefined'
			&& typeof window.matchMedia === 'function'
			&& window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const intervalMs = reduceMotion ? Math.max(frameDurationMs * 4, 1000) : frameDurationMs;
		const id = window.setInterval(() => {
			setFrameIdx(i => (i + 1) % LOADING_GLYPH_FRAMES.length);
		}, intervalMs);
		return () => window.clearInterval(id);
	}, [frameDurationMs]);

	const dots = (
		<span
			className={`loading-glyph ${inline ? 'ml-1' : ''}`}
			aria-label={state === 'thinking' ? chatS.loadingThinkingAria : state === 'typing' ? chatS.loadingTypingAria : state === 'processing' ? chatS.loadingProcessingAria : chatS.loadingDefaultAria}
			role="status"
		>
			{LOADING_GLYPH_FRAMES[frameIdx]}
		</span>
	);

	return (
		<div className={`inline-flex items-center gap-1 ${className}`}>
			{dots}
			{tokenText && (
				<span className={`text-xs opacity-70 ${shouldPulse ? 'token-count-update' : ''}`}>
					{tokenText}
				</span>
			)}
		</div>
	);
};

// Inline banner shown when the LLM stream watchdog detects a stall (no new tokens for too long).
// Lets the user abort or re-send the last user message without leaving the chat.
const StallBanner = ({
	stalledAt,
	onAbort,
	onRetry,
}: {
	stalledAt: number;
	onAbort: () => void;
	onRetry: () => void;
}) => {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, []);
	const elapsedSec = Math.max(0, Math.round((now - stalledAt) / 1000));
	return (
		<div
			className="flex items-center gap-2 px-2 py-1 rounded border border-vibe-border-2 text-vibe-warning text-xs"
			role="alert"
			aria-live="polite"
		>
			<IconWarning size={14} className="flex-shrink-0" />
			<span className="flex-1 text-vibe-fg-2">Модель молчит ~{elapsedSec}s — возможно, стрим завис.</span>
			<button
				type="button"
				onClick={onAbort}
				className="px-2 py-0.5 rounded border border-vibe-border-2 text-vibe-fg-2 hover:bg-vibe-bg-2-hover"
			>
				Прервать
			</button>
			<button
				type="button"
				onClick={onRetry}
				className="px-2 py-0.5 rounded border border-vibe-warning text-vibe-warning hover:bg-vibe-bg-2-hover"
			>
				Повторить
			</button>
		</div>
	);
};

// Inline banner shown while a provider rate-limit auto-pause counts down to an automatic resume.
// The run already schedules the resume itself; this just makes the wait visible and offers to skip it.
const RateLimitPauseBanner = ({
	resumeAtMs,
	attempt,
	maxAttempts,
	onResumeNow,
}: {
	resumeAtMs: number;
	attempt: number;
	maxAttempts: number;
	onResumeNow: () => void;
}) => {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, []);
	const remainingSec = Math.max(0, Math.round((resumeAtMs - now) / 1000));
	const mm = Math.floor(remainingSec / 60);
	const ss = remainingSec % 60;
	const clock = mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${ss}с`;
	return (
		<div
			className="flex items-center gap-2 px-2 py-1 rounded border border-vibe-border-2 text-vibe-warning text-xs"
			role="status"
			aria-live="polite"
		>
			<IconWarning size={14} className="flex-shrink-0" />
			<span className="flex-1 text-vibe-fg-2">
				{remainingSec > 0
					? `Провайдер взял паузу (лимит запросов). Автопродолжение через ${clock} · попытка ${attempt} из ${maxAttempts}`
					: 'Продолжаю…'}
			</span>
			<button
				type="button"
				onClick={onResumeNow}
				className="px-2 py-0.5 rounded border border-vibe-warning text-vibe-warning hover:bg-vibe-bg-2-hover"
			>
				Продолжить сейчас
			</button>
		</div>
	);
};

// Spinner — rotating ring shown while model is generating (before first token arrives)
export const Spinner = ({ className = '', size = 15 }: { className?: string; size?: number }) => (
	<LoaderCircle
		size={size}
		className={`animate-spin flex-shrink-0 ${className}`}
		aria-hidden="true"
	/>
);

// Typing cursor component for inline use at end of streaming content
export const TypingCursor = ({ className = '' }: { className?: string }) => {
	return (
		<span
			className={`typing-cursor ${className}`}
			aria-hidden="true"
		/>
	);
};



// SLIDER ONLY:
const ReasoningOptionSlider = ({ featureName }: { featureName: FeatureName }) => {
	const accessor = useAccessor();

	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const vibeSettingsState = useSettingsState();

	const modelSelection = vibeSettingsState.modelSelectionOfFeature[featureName];
	const overridesOfModel = vibeSettingsState.overridesOfModel;

	if (!modelSelection) {return null;}

	// Skip "auto" - it's not a real provider
	if (!isValidProviderModelSelection(modelSelection)) {
		return null;
	}

	const { modelName, providerName } = modelSelection;
	const { reasoningCapabilities } = getModelCapabilities(providerName, modelName, overridesOfModel);
	const { canTurnOffReasoning, reasoningSlider: reasoningBudgetSlider } = reasoningCapabilities || {};

	const modelSelectionOptions = vibeSettingsState.optionsOfModelSelection[featureName][providerName]?.[modelName];
	const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel);

	// Pill container matches the neighbouring toolbar controls («подпин.», autopilot…) —
	// previously this control had no border and a fixed 40px label that overflowed onto
	// the slider thumb («Рассужде…» over the knob).
	if (canTurnOffReasoning && !reasoningBudgetSlider) { // if it's just a on/off toggle without a power slider
		return <div className='@@vibe-toolbar-pill flex items-center gap-x-2 flex-shrink-0 rounded-xl py-0.5 px-1.5'>
			<span className='text-vibe-fg-3 text-xs pointer-events-none whitespace-nowrap'>{chatS.thinkingLabel}</span>
			<VibeSwitch
				size='xxs'
				value={isReasoningEnabled}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && !newVal;
					vibeideSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff });
				}}
			/>
		</div>;
	}

	if (reasoningBudgetSlider?.type === 'budget_slider') { // if it's a slider
		const { min: min_, max, default: defaultVal } = reasoningBudgetSlider;

		const nSteps = 8; // only used in calculating stepSize, stepSize is what actually matters
		const stepSize = Math.round((max - min_) / nSteps);

		const valueIfOff = min_ - stepSize;
		const min = canTurnOffReasoning ? valueIfOff : min_;
		const value = isReasoningEnabled ? vibeSettingsState.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]?.reasoningBudget ?? defaultVal
			: valueIfOff;

		return <div className='@@vibe-toolbar-pill flex items-center gap-x-2 flex-shrink-0 rounded-xl py-0.5 px-1.5'>
			<span className='text-vibe-fg-3 text-xs pointer-events-none whitespace-nowrap'>{chatS.thinkingLabel}</span>
			<VibeSlider
				width={50}
				size='xs'
				min={min}
				max={max}
				step={stepSize}
				value={value}
				onChange={(newVal) => {
					if (modelSelection.providerName === 'auto' && modelSelection.modelName === 'auto') {return;}
					const isOff = canTurnOffReasoning && newVal === valueIfOff;
					vibeideSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff, reasoningBudget: newVal });
				}}
			/>
			<span className='text-vibe-fg-3 text-xs pointer-events-none whitespace-nowrap'>{isReasoningEnabled ? `${value} ${chatS.tokensSuffix}` : chatS.thinkingDisabled}</span>
		</div>;
	}

	if (reasoningBudgetSlider?.type === 'effort_slider') {

		const { values, default: defaultVal } = reasoningBudgetSlider;

		const min = canTurnOffReasoning ? -1 : 0;
		const max = values.length - 1;

		const currentEffort = vibeSettingsState.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]?.reasoningEffort ?? defaultVal;
		const valueIfOff = -1;
		const value = isReasoningEnabled && currentEffort ? values.indexOf(currentEffort) : valueIfOff;

		const currentEffortCapitalized = currentEffort.charAt(0).toUpperCase() + currentEffort.slice(1, Infinity);

		return <div className='@@vibe-toolbar-pill flex items-center gap-x-2 flex-shrink-0 rounded-xl py-0.5 px-1.5'>
			<span className='text-vibe-fg-3 text-xs pointer-events-none whitespace-nowrap'>{chatS.thinkingLabel}</span>
			<VibeSlider
				width={30}
				size='xs'
				min={min}
				max={max}
				step={1}
				value={value}
				onChange={(newVal) => {
					if (modelSelection.providerName === 'auto' && modelSelection.modelName === 'auto') {return;}
					const isOff = canTurnOffReasoning && newVal === valueIfOff;
					vibeideSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff, reasoningEffort: values[newVal] ?? undefined });
				}}
			/>
			<span className='text-vibe-fg-3 text-xs pointer-events-none whitespace-nowrap'>{isReasoningEnabled ? `${currentEffortCapitalized}` : chatS.thinkingDisabled}</span>
		</div>;
	}

	return null;
};





const ChatModeDropdown = ({ className }: { className: string }) => {
	const accessor = useAccessor();

	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const settingsState = useSettingsState();

	const options: ChatMode[] = useMemo(() => ['normal', 'gather', 'plan', 'agent'], []);

	const onChangeOption = useCallback((newVal: ChatMode) => {
		vibeideSettingsService.setGlobalSetting('chatMode', newVal);
	}, [vibeideSettingsService]);

	return <VibeCustomDropdownBox
		className={className}
		options={options}
		selectedOption={settingsState.globalSettings.chatMode}
		onChangeOption={onChangeOption}
		getOptionDisplayName={(val) => chatModeDisplayName[val]}
		getOptionDropdownName={(val) => chatModeDisplayName[val]}
		getOptionDropdownDetail={(val) => chatModeDetail[val]}
		getOptionsEqual={(a, b) => a === b}
		detailPresentation="tooltip"
	/>;

};

/** Toolbar: auto-run all agent tools without per-step approval (incl. deletes & terminal). Off = confirm each tool. */
const ChatAgentAutopilotToggle = ({ className }: { className?: string }) => {
	const accessor = useAccessor();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const configurationService = accessor.get('IConfigurationService');
	const metricsService = accessor.get('IMetricsService');
	const settingsState = useSettingsState();

	const onChange = useCallback((v: boolean) => {
		vibeideSettingsService.setGlobalSetting('chatAgentAutopilot', v);
		// #5 — couple with the iterations counter: full autonomy ON → no pause (counter 0); OFF →
		// controlled mode (bounded counter, pause + confirmations). Mirror of ChatAgentIterationsControl.
		configurationService.updateValue(SOFT_CHECKPOINT_KEY, v ? 0 : SOFT_CHECKPOINT_CONTROLLED);
		metricsService.capture('Chat Agent Autopilot Toggle', { enabled: v });
	}, [vibeideSettingsService, configurationService, metricsService]);

	const mode = settingsState.globalSettings.chatMode;
	if (mode !== 'agent' && mode !== 'plan') {
		return null;
	}

	return (
		<div
			className={`@@vibe-toolbar-pill flex items-center gap-1 flex-shrink-0 rounded-xl py-0.5 px-1.5 ${className ?? ''}`}
			title={chatS.autopilotTitle}
		>
			<VibeSwitch size='xs' value={settingsState.globalSettings.chatAgentAutopilot === true} onChange={onChange} />
			<span className='text-vibe-fg-3 text-xs whitespace-nowrap select-none pointer-events-none'>{chatS.autopilotLabel}</span>
		</div>
	);
};

const PROJECT_RULES_RESOLVE_LINKS_KEY = 'vibeide.projectRules.resolveLinks';
const PROJECT_RULES_RESOLVE_LINKS_RECURSIVE_KEY = 'vibeide.projectRules.resolveLinksRecursive';

/** Toolbar mirror of `vibeide.projectRules.resolveLinksRecursive` — recursive following of links in
 *  project rules. Pure duplicate of the setting (config is the source of truth). Hidden when link
 *  resolution itself (`resolveLinks`) is off, since recursion is then moot. */
const ChatRuleLinksRecursiveToggle = ({ className }: { className?: string }) => {
	const accessor = useAccessor();
	const configurationService = accessor.get('IConfigurationService');

	const readValue = useCallback((): boolean => configurationService.getValue<boolean>(PROJECT_RULES_RESOLVE_LINKS_RECURSIVE_KEY) === true, [configurationService]);
	const readEnabled = useCallback((): boolean => (configurationService.getValue<boolean>(PROJECT_RULES_RESOLVE_LINKS_KEY) ?? true) === true, [configurationService]);

	const [value, setValue] = useState<boolean>(readValue);
	const [enabled, setEnabled] = useState<boolean>(readEnabled);
	useEffect(() => {
		const d = configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PROJECT_RULES_RESOLVE_LINKS_RECURSIVE_KEY)) { setValue(readValue()); }
			if (e.affectsConfiguration(PROJECT_RULES_RESOLVE_LINKS_KEY)) { setEnabled(readEnabled()); }
		});
		return () => d.dispose();
	}, [configurationService, readValue, readEnabled]);

	const onChange = useCallback((v: boolean) => {
		configurationService.updateValue(PROJECT_RULES_RESOLVE_LINKS_RECURSIVE_KEY, v);
	}, [configurationService]);

	if (!enabled) { return null; }

	return (
		<div
			className={`@@vibe-toolbar-pill flex items-center gap-1 flex-shrink-0 rounded-xl py-0.5 px-1.5 ${className ?? ''}`}
			title={chatS.rulesLinksRecursiveTitle}
		>
			<VibeSwitch size='xs' value={value} onChange={onChange} />
			<span className='text-vibe-fg-3 text-xs whitespace-nowrap select-none pointer-events-none'>{chatS.rulesLinksRecursiveLabel}</span>
		</div>
	);
};


/**
 * Toolbar quick-reset for the SESSION token counter (same `vibeide.tokenBudget.reset` command as
 * the full TokenBudgetFooter in history — one source of reset logic). Lives right after the
 * Autopilot toggle for quick access; tooltip shows the current spend so the click is informed.
 */
const ChatSessionResetButton = ({ className }: { className?: string }) => {
	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const budgetService = accessor.get('IVibeTokenBudgetService');
	const settingsState = useSettingsState();
	const [used, setUsed] = useState<number>(() => budgetService.getStatus().sessionTokensUsed);
	useEffect(() => {
		const d = budgetService.onBudgetStatusChanged(s => setUsed(s.sessionTokensUsed));
		return () => d.dispose();
	}, [budgetService]);

	const onClick = useCallback(() => {
		void commandService.executeCommand('vibeide.tokenBudget.reset');
	}, [commandService]);

	const mode = settingsState.globalSettings.chatMode;
	if (mode !== 'agent' && mode !== 'plan') { return null; }
	return (
		<div className={`@@vibe-toolbar-pill flex items-center flex-shrink-0 rounded-xl py-0.5 px-1.5 ${className ?? ''}`}>
			<button
				type='button'
				onClick={onClick}
				title={chatS.sessionResetTitle(used.toLocaleString('ru-RU'))}
				aria-label={chatS.sessionResetAria}
				className='flex items-center justify-center text-vibe-fg-3 hover:text-vibe-fg-1 leading-none select-none cursor-pointer'
			>
				<RotateCcw size={12} />
			</button>
		</div>
	);
};


/** Single agent-iterations control = soft-checkpoint pause (`vibeide.agent.softCheckpointIterations`). 0 = run to completion. */
const SOFT_CHECKPOINT_DEFAULT = 0; // mirrors the registered config default: ∞ / no pauses (autopilot-on world)
const SOFT_CHECKPOINT_CONTROLLED = 25; // value the counter snaps to when the user flips Autopilot OFF (controlled mode)
const SOFT_CHECKPOINT_UPPER = 500;
const SOFT_CHECKPOINT_KEY = 'vibeide.agent.softCheckpointIterations';
/** Auto-continue nudges control (`vibeide.agent.autoContinueMaxNudges`): how many CONSECUTIVE
 * text-only turns autopilot auto-nudges the model to continue. 0 = off (stop immediately). */
const AUTO_NUDGES_DEFAULT = 2;
const AUTO_NUDGES_UPPER = 10;
const AUTO_NUDGES_KEY = 'vibeide.agent.autoContinueMaxNudges';

/**
 * Reusable numeric stepper bound to a config key: [−] [input] [+] [label]. 0 renders an off-label.
 * Pointer events are stopped from bubbling so the composer's click/mousedown refocus can't yank focus
 * back to the chat textarea the moment you interact with these controls (the reported focus-steal bug).
 */
const NumberStepperControl = ({ className, configKey, defaultValue, upper, label, offLabel, offHint, title, presets, onValueCommitted }: {
	className?: string;
	configKey: string;
	defaultValue: number;
	upper: number;
	label: string;
	offLabel: string;
	offHint: string;
	title: string;
	presets?: number[];
	onValueCommitted?: (value: number) => void;
}) => {
	const accessor = useAccessor();
	const configurationService = accessor.get('IConfigurationService');

	const readValue = useCallback((): number => {
		const raw = configurationService.getValue<unknown>(configKey);
		if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
			return Math.min(upper, Math.floor(raw));
		}
		return defaultValue;
	}, [configurationService, configKey, defaultValue, upper]);

	const [value, setValue] = useState<number>(readValue);
	const [draft, setDraft] = useState<string>(() => String(readValue()));

	useEffect(() => {
		const d = configurationService.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration(configKey)) {return;}
			const next = readValue();
			setValue(next);
			setDraft(String(next));
		});
		return () => d.dispose();
	}, [configurationService, readValue, configKey]);

	const commit = useCallback((next: number) => {
		const clamped = Math.max(0, Math.min(upper, Math.floor(next)));
		setValue(clamped);
		setDraft(String(clamped));
		configurationService.updateValue(configKey, clamped);
		onValueCommitted?.(clamped);
	}, [configurationService, configKey, upper, onValueCommitted]);

	const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		setDraft(e.target.value);
	}, []);

	const onBlur = useCallback(() => {
		const parsed = parseInt(draft, 10);
		if (Number.isFinite(parsed)) {
			commit(parsed);
		} else {
			setDraft(String(value));
		}
	}, [draft, value, commit]);

	const onKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			(e.target as HTMLInputElement).blur();
		} else if (e.key === 'Escape') {
			setDraft(String(value))
			;(e.target as HTMLInputElement).blur();
		}
	}, [value]);

	// Focus-steal fix: keep pointer events from reaching the composer's refocus handlers.
	const stop = useCallback((e: React.SyntheticEvent) => { e.stopPropagation(); }, []);

	const isDisabled = value === 0;
	const titleSuffix = isDisabled ? ` (${offHint})` : ` — ${value}`;
	const btnCls = 'flex items-center justify-center w-4 h-4 rounded text-vibe-fg-3 leading-none select-none cursor-pointer hover:bg-vibe-bg-2 disabled:opacity-40 disabled:cursor-default';

	return (
		<div
			className={`@@vibe-toolbar-pill flex items-center gap-0.5 flex-shrink-0 rounded-xl py-0.5 px-1.5 ${className ?? ''}`}
			title={title + titleSuffix}
			onMouseDown={stop}
			onClick={stop}
		>
			<button
				type='button'
				className={btnCls}
				aria-label={chatS.iterStepperDec}
				disabled={value <= 0}
				onMouseDown={stop}
				onClick={(e) => { stop(e); commit(value - 1); }}
			>−</button>
			<input
				type='number'
				min={0}
				max={upper}
				step={1}
				value={draft}
				onChange={onInputChange}
				onBlur={onBlur}
				onKeyDown={onKeyDown}
				onMouseDown={stop}
				onClick={stop}
				className='w-8 text-xs text-vibe-fg-3 bg-transparent border-0 outline-none text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'
				aria-label={title}
			/>
			<button
				type='button'
				className={btnCls}
				aria-label={chatS.iterStepperInc}
				disabled={value >= upper}
				onMouseDown={stop}
				onClick={(e) => { stop(e); commit(value + 1); }}
			>+</button>
			<span className='text-vibe-fg-3 text-xs whitespace-nowrap select-none pointer-events-none ml-0.5'>
				{isDisabled ? offLabel : label}
			</span>
			{presets && presets.length > 0 && (
				<span className='flex items-center gap-0.5 ml-1 pl-1 border-l border-vibe-border-3'>
					{presets.map(p => (
						<button
							key={p}
							type='button'
							className={`px-1 rounded text-[10px] leading-none select-none cursor-pointer ${p === value ? 'text-vibe-fg-1 bg-vibe-bg-2' : 'text-vibe-fg-4 hover:text-vibe-fg-2'}`}
							title={p === 0 ? offLabel : `${label} ${p}`}
							onMouseDown={stop}
							onClick={(e) => { stop(e); commit(p); }}
						>{p === 0 ? '∞' : p}</button>
					))}
				</span>
			)}
		</div>
	);
};

/**
 * Single agent-iterations control. Bound to the soft-checkpoint (`vibeide.agent.softCheckpointIterations`):
 * after N steps in one run the agent pauses and asks «продолжить?»; `0` = no pause, run to completion.
 * (The old hard `maxLoopIterations` cap is removed from the UI and defaults to 0 so it can't silently
 * stop before this — a single, predictable counter.) Coupled with Autopilot (#5): committing `0` turns
 * Autopilot ON (full autonomy: no pause + auto-approve); any value >0 turns it OFF (controlled mode).
 */
const ChatAgentIterationsControl = ({ className }: { className?: string }) => {
	const accessor = useAccessor();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const settingsState = useSettingsState();

	const onValueCommitted = useCallback((n: number) => {
		// Two-way coupling: counter 0 ⟺ Autopilot ON (full autonomy). >0 ⟺ controlled (pause + confirm).
		const autopilot = n === 0;
		if ((settingsState.globalSettings.chatAgentAutopilot === true) !== autopilot) {
			vibeideSettingsService.setGlobalSetting('chatAgentAutopilot', autopilot);
		}
	}, [vibeideSettingsService, settingsState.globalSettings.chatAgentAutopilot]);

	const mode = settingsState.globalSettings.chatMode;
	if (mode !== 'agent' && mode !== 'plan') { return null; }
	return (
		<NumberStepperControl
			className={className}
			configKey={SOFT_CHECKPOINT_KEY}
			defaultValue={SOFT_CHECKPOINT_DEFAULT}
			upper={SOFT_CHECKPOINT_UPPER}
			label={chatS.maxLoopIterationsLabel}
			offLabel={chatS.maxLoopIterationsOffLabel}
			offHint={chatS.maxLoopIterationsOffHint}
			title={chatS.softCheckpointTitle}
			presets={[0, 25, 50, 100]}
			onValueCommitted={onValueCommitted}
		/>
	);
};

/**
 * Auto-continue nudges control («автоподпинывание»). Bound to `vibeide.agent.autoContinueMaxNudges`:
 * under Autopilot, when the model ends a turn with plain text and NO tool call (weak-tool-calling
 * artefact), the agent auto-nudges it to continue up to N CONSECUTIVE times (counter resets on every
 * executed tool call). `0` = off — stop immediately even under Autopilot. Quick toolbar access next
 * to the iterations counter; global setting, not part of the per-tab chat config.
 */
const ChatAgentNudgesControl = ({ className }: { className?: string }) => {
	const settingsState = useSettingsState();

	const mode = settingsState.globalSettings.chatMode;
	if (mode !== 'agent' && mode !== 'plan') { return null; }
	return (
		<NumberStepperControl
			className={className}
			configKey={AUTO_NUDGES_KEY}
			defaultValue={AUTO_NUDGES_DEFAULT}
			upper={AUTO_NUDGES_UPPER}
			label={chatS.autoNudgesLabel}
			offLabel={chatS.autoNudgesOffLabel}
			offHint={chatS.autoNudgesOffHint}
			title={chatS.autoNudgesTitle}
			presets={[0, 2, 5]}
		/>
	);
};

/**
 * Question-nudge control («подпин?»). Bound to `vibeide.agent.autoContinueOnQuestion`: under
 * Autopilot a turn that ENDS with «?» is always auto-continued — it does not spend the regular
 * nudge budget on the left. N = max CONSECUTIVE question-nudges (counter resets on every executed
 * tool call); `0` = unlimited (∞) — inverse of «подпин.» where 0 means off. Default 3.
 */
const QUESTION_NUDGES_DEFAULT = 3;
const QUESTION_NUDGES_UPPER = 10;
const QUESTION_NUDGES_KEY = 'vibeide.agent.autoContinueOnQuestion';

const ChatAgentQuestionNudgesControl = ({ className }: { className?: string }) => {
	const settingsState = useSettingsState();

	const mode = settingsState.globalSettings.chatMode;
	if (mode !== 'agent' && mode !== 'plan') { return null; }
	return (
		<NumberStepperControl
			className={className}
			configKey={QUESTION_NUDGES_KEY}
			defaultValue={QUESTION_NUDGES_DEFAULT}
			upper={QUESTION_NUDGES_UPPER}
			label={chatS.questionNudgesLabel}
			offLabel={chatS.questionNudgesOffLabel}
			offHint={chatS.questionNudgesOffHint}
			title={chatS.questionNudgesTitle}
			presets={[0, 5, 10]}
		/>
	);
};



interface VibeideChatAreaProps {
	// Required
	children: React.ReactNode; // This will be the input component

	// Form controls
	onSubmit: () => void;
	onAbort: () => void;
	isStreaming: boolean;
	isDisabled?: boolean;
	divRef?: React.RefObject<HTMLDivElement | null>;

	// UI customization
	className?: string;
	showModelDropdown?: boolean;
	showSelections?: boolean;
	showProspectiveSelections?: boolean;
	loadingIcon?: React.ReactNode;

	selections?: StagingSelectionItem[];
	setSelections?: (s: StagingSelectionItem[]) => void;
	// selections?: any[];
	// onSelectionsChange?: (selections: any[]) => void;

	onClickAnywhere?: () => void;
	// Optional close button
	onClose?: () => void;

	// Image attachments
	imageAttachments?: React.ReactNode;
	onImageDrop?: (files: File[]) => void;
	onImageUpload?: () => void;
	onPDFDrop?: (files: File[]) => void;
	pdfAttachments?: React.ReactNode;

	featureName: FeatureName;

	/** When false, hide anchored chat history control (e.g. inline message editor). Default: true for Chat. */
	showChatHistoryControl?: boolean;

	/** Quick-continue: send the configured nudge text (`vibeide.chat.continueButtonText`) as a
	 *  user message. When provided, a StepForward button renders left of the send arrow
	 *  (hidden while streaming — the arrow is a Stop button then). */
	onContinue?: (text: string) => void;
}

/** Config-backed text for the quick-continue button — also used as its tooltip. */
const CONTINUE_TEXT_KEY = 'vibeide.chat.continueButtonText';
const CONTINUE_TEXT_DEFAULT = 'продолжи';

const ChatContinueButton = ({ onSend }: { onSend: (text: string) => void }) => {
	const accessor = useAccessor();
	const configurationService = accessor.get('IConfigurationService');

	const readText = useCallback((): string => {
		const raw = configurationService.getValue<unknown>(CONTINUE_TEXT_KEY);
		return (typeof raw === 'string' && raw.trim().length > 0) ? raw.trim() : CONTINUE_TEXT_DEFAULT;
	}, [configurationService]);

	const [text, setText] = useState<string>(readText);
	useEffect(() => {
		const d = configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONTINUE_TEXT_KEY)) { setText(readText()); }
		});
		return () => d.dispose();
	}, [configurationService, readText]);

	return (
		<button
			type="button"
			onClick={() => onSend(text)}
			className="flex-shrink-0 p-1.5 rounded-xl hover:bg-vibe-bg-2-alt text-vibe-fg-4 hover:text-vibe-fg-2 transition-colors"
			aria-label={text}
			title={text}
		>
			<StepForward size={16} />
		</button>
	);
};

/** CDN catalog hint next to Chat model picker (training / data-use). */
const ChatTrainingPolicyBadge: React.FC = () => {
	const settingsState = useSettingsState();
	const accessor = useAccessor();
	const sel = settingsState.modelSelectionOfFeature['Chat'];
	if (!sel || (sel.providerName === 'auto' && sel.modelName === 'auto')) {
		return null;
	}
	if (!isValidProviderModelSelection(sel)) {
		return null;
	}
	const policy = accessor.get('IVibeModelsRegistryService').getTrainingPolicyForSelection(sel.providerName, sel.modelName);
	const short = policy === undefined ? chatS.trainingUnknown
		: policy === 'none' ? chatS.trainingNone
			: policy === 'opt-in' ? chatS.trainingOptIn
				: policy === 'opt-out-available' ? chatS.trainingOptOut
					: chatS.trainingMayTrain;
	const tip = policy === undefined
		? chatS.trainingTipUnknown
		: policy === 'none' ? chatS.trainingTipNone
			: policy === 'opt-in' ? chatS.trainingTipOptIn
				: policy === 'opt-out-available' ? chatS.trainingTipOptOut
					: chatS.trainingTipMayTrain;
	return (
		<span
			className="text-[10px] leading-tight text-vibe-fg-4 border border-vibe-border-2 rounded-xl px-1.5 py-0.5 max-w-[5.5rem] truncate"
			title={`${displayInfoOfProviderName(sel.providerName).title}/${sel.modelName}\n${tip}`}
		>
			📚 {short}
		</span>
	);
};

/** Model dropdown that lights up (orange ring + ⚠ tooltip) when the current provider×model is
 *  degrading (3099): a series of provider errors (520/529, rate/usage limit, overload, stream
 *  stall) within ~10 min. Clicking the chip opens the model list as usual — the warning sits right
 *  where you switch models, so no separate status-bar item or extra command is needed. */
const ChatModelHealthDropdown: React.FC<{ featureName: FeatureName; className: string }> = ({ featureName, className }) => {
	const accessor = useAccessor();
	const settingsState = useSettingsState();
	const chatThreadsService = accessor.get('IChatThreadService');
	const [, setHealthTick] = useState(0);
	useEffect(() => {
		const d = chatThreadsService.onDidChangeProviderHealth(() => setHealthTick(t => t + 1));
		return () => d.dispose();
	}, [chatThreadsService]);
	const sel = settingsState.modelSelectionOfFeature[featureName];
	const degraded = !!sel && isValidProviderModelSelection(sel) && chatThreadsService.isProviderDegraded(sel.providerName, sel.modelName);
	const dropdown = <ModelDropdown featureName={featureName} className={degraded ? `${className} ring-1 ring-orange-500/70 !text-orange-400` : className} />;
	return degraded
		? <span className='inline-flex' title={chatS.providerDegradedTooltip}>{dropdown}</span>
		: dropdown;
};

export const VibeChatArea: React.FC<VibeideChatAreaProps> = ({
	children,
	onSubmit,
	onAbort,
	onClose,
	onClickAnywhere,
	divRef,
	isStreaming = false,
	isDisabled = false,
	className = '',
	showModelDropdown = true,
	showSelections = false,
	showProspectiveSelections = false,
	selections,
	setSelections,
	imageAttachments,
	onImageDrop,
	onImageUpload,
	onPDFDrop,
	pdfAttachments,
	featureName,
	showChatHistoryControl = true,
	loadingIcon,
	onContinue,
}) => {
	const [isDragOver, setIsDragOver] = React.useState(false);
	const imageInputRef = React.useRef<HTMLInputElement>(null);
	const pdfInputRef = React.useRef<HTMLInputElement>(null);
	const containerRef = React.useRef<HTMLDivElement>(null);

	// Paste of files (images / PDFs) is handled directly on the textarea via onPaste prop in VibeInputBox2 —
	// container-level paste listener was removed because it duplicated processing in bubble phase.

	// Throttle drag over events to prevent jank
	const lastDragOverTimeRef = React.useRef<number>(0);
	const DRAG_THROTTLE_MS = 50; // Update at most every 50ms

	// Handle drag and drop
	const handleDragOver = React.useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();

		const now = Date.now();
		if (now - lastDragOverTimeRef.current < DRAG_THROTTLE_MS) {
			return;
		}
		lastDragOverTimeRef.current = now;

		const hasFiles = Array.from(e.dataTransfer.items).some(item =>
			item.type.startsWith('image/') || item.type === 'application/pdf'
		);
		if (hasFiles) {
			setIsDragOver(true);
		}
	}, []);

	const handleDragLeave = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);

		const imageFiles = Array.from(e.dataTransfer.files).filter(file =>
			file.type.startsWith('image/')
		);
		const pdfFiles = Array.from(e.dataTransfer.files).filter(file =>
			file.type === 'application/pdf'
		);

		if (imageFiles.length > 0 && onImageDrop) {
			onImageDrop(imageFiles);
		}
		if (pdfFiles.length > 0 && onPDFDrop) {
			onPDFDrop(pdfFiles);
		}
	};

	const handleImageUploadClick = () => {
		imageInputRef.current?.click();
	};

	const handlePDFUploadClick = () => {
		pdfInputRef.current?.click();
	};

	const handleImageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files || []).filter(file =>
			file.type.startsWith('image/')
		);
		if (files.length > 0 && onImageDrop) {
			onImageDrop(files);
		}
		e.target.value = ''; // Reset input
	};

	const handlePDFInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files || []).filter(file =>
			file.type === 'application/pdf'
		);
		if (files.length > 0 && onPDFDrop) {
			onPDFDrop(files);
		}
		e.target.value = ''; // Reset input
	};

	return (
		<div
			ref={(node) => {
				if (divRef) {
					if (typeof divRef === 'function') {
						divRef(node);
					} else {
						divRef.current = node;
					}
				}
				containerRef.current = node;
			}}
			className={`
				@@chat-composer-shell
				${isDragOver ? '@@chat-composer-shell--drag' : ''}
				gap-x-1
                flex flex-col p-2.5 relative input text-left shrink-0 w-full min-w-0
                rounded-2xl
				transition-colors duration-200
				max-h-[80vh] overflow-y-auto
                ${className}
            `}
			onClick={(e) => {
				// Don't pull focus back to the textarea when the click landed on an interactive
				// control inside the composer (iterations <input>, model dropdown, buttons) — the
				// click-release refocus otherwise steals focus and those inputs can't be edited.
				if ((e.target as HTMLElement).closest('input,textarea,select,button,[contenteditable]')) { return; }
				onClickAnywhere?.();
			}}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{/* Hidden file inputs - separate for images and PDFs */}
			<input
				ref={imageInputRef}
				type="file"
				accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
				multiple
				className="hidden"
				onChange={handleImageInputChange}
			/>
			<input
				ref={pdfInputRef}
				type="file"
				accept="application/pdf"
				multiple
				className="hidden"
				onChange={handlePDFInputChange}
			/>

			{/* Image attachments section */}
			{imageAttachments}

			{/* PDF attachments section */}
			{pdfAttachments}

			{/* Selections section */}
			{showSelections && selections && setSelections && (
				<SelectedFiles
					type='staging'
					selections={selections}
					setSelections={setSelections}
					showProspectiveSelections={showProspectiveSelections}
				/>
			)}

			{/* Input section - Modern Cursor-style layout */}
			<div className="relative w-full flex items-end gap-2">
				<div className="flex-1 min-w-0">
					{children}
				</div>

				{/* Right-side icon bar - Cursor style */}
				<div className="flex items-center gap-1 flex-shrink-0 pb-0.5">
					{/* Image upload button */}
					<button
						type="button"
						onClick={handleImageUploadClick}
						className="flex-shrink-0 p-1.5 rounded-xl hover:bg-vibe-bg-2-alt text-vibe-fg-4 hover:text-vibe-fg-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						aria-label={chatS.uploadImagesAria}
						title={chatS.uploadImagesTitle}
					>
						<ImageIcon size={16} />
					</button>

					{/* PDF upload button */}
					<button
						type="button"
						onClick={handlePDFUploadClick}
						className="flex-shrink-0 p-1.5 rounded-xl hover:bg-vibe-bg-2-alt text-vibe-fg-4 hover:text-vibe-fg-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						aria-label={chatS.uploadPdfsAria}
						title={chatS.uploadPdfsTitle}
					>
						<FileText size={16} />
					</button>

					{/* Quick-continue button — left of the send arrow, hidden while streaming */}
					{!isStreaming && onContinue && <ChatContinueButton onSend={onContinue} />}

					{/* Submit button */}
					{isStreaming ? (
						<ButtonStop onClick={onAbort} />
					) : (
						<ButtonSubmit
							onClick={onSubmit}
							disabled={isDisabled}
						/>
					)}
				</div>

				{/* Close button (X) if onClose is provided */}
				{onClose && (
					<div className='absolute -top-1 -right-1 cursor-pointer z-1'>
						<IconX
							size={12}
							className="stroke-[2] opacity-80 text-vibe-fg-3 hover:brightness-95"
							onClick={onClose}
						/>
					</div>
				)}
			</div>

			{/* Bottom row — left: mode/model/options; right: loading + chat history */}
			<div className='@@chat-composer-toolbar-rule flex flex-row items-center gap-2 mt-1 pt-2.5 min-w-0'>
				{showModelDropdown && (
					<div className='flex items-center flex-wrap gap-x-2 gap-y-1 text-nowrap flex-1 min-w-0'>
						{featureName === 'Chat' && <ChatModeDropdown className='text-xs text-vibe-fg-3 @@vibe-toolbar-pill rounded-xl overflow-hidden py-0.5 px-1.5' />}
						<ChatModelHealthDropdown featureName={featureName} className='text-xs text-vibe-fg-3 @@vibe-toolbar-pill rounded-xl overflow-hidden py-0.5 px-1.5' />
						{featureName === 'Chat' && <ChatTrainingPolicyBadge />}
						{featureName === 'Chat' && <ChatAgentAutopilotToggle />}
						{featureName === 'Chat' && <ChatRuleLinksRecursiveToggle />}
						{featureName === 'Chat' && <ChatSessionResetButton />}
						{featureName === 'Chat' && <ChatAgentIterationsControl />}
						{featureName === 'Chat' && <ChatAgentNudgesControl />}
						{featureName === 'Chat' && <ChatAgentQuestionNudgesControl />}
						<ReasoningOptionSlider featureName={featureName} />
					</div>
				)}
				<div className='flex shrink-0 items-center gap-2'>
					{isStreaming && loadingIcon ? (
						<div className="flex items-center">
							{loadingIcon}
						</div>
					) : null}
					{featureName === 'Chat' && showChatHistoryControl !== false ? (
						<ChatHistoryToolbarDropdown className='text-xs text-vibe-fg-3 @@vibe-toolbar-pill rounded-xl overflow-hidden py-0.5 px-1.5 h-4 items-center' />
					) : null}
				</div>
			</div>
		</div>
	);
};



type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;
const DEFAULT_BUTTON_SIZE = 22;
export const ButtonSubmit = ({ className, disabled, ...props }: ButtonProps & Required<Pick<ButtonProps, 'disabled'>>) => {

	return <button
		type='button'
		className={`rounded-full flex-shrink-0 flex-grow-0 flex items-center justify-center
			button-press-animation
			${disabled ? 'bg-vscode-disabled-fg cursor-default opacity-50' : 'cursor-pointer bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground,var(--vscode-button-background))]'}
			${className}
		`}
		disabled={disabled}
		aria-label={chatS.sendMessageAria}
		// data-tooltip-id='vibe-tooltip'
		// data-tooltip-content={'Send'}
		// data-tooltip-place='left'
		{...props}
	>
		<IconArrowUp size={DEFAULT_BUTTON_SIZE} className="stroke-[2] p-[2px]" />
	</button>;
};

export const ButtonStop = ({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => {
	return <button
		className={`rounded-full flex-shrink-0 flex-grow-0 cursor-pointer flex items-center justify-center
			bg-white hover:bg-red-50 button-press-animation
			${className}
		`}
		type='button'
		aria-label={chatS.stopGenerationAria}
		{...props}
	>
		<IconSquare size={DEFAULT_BUTTON_SIZE} className="stroke-[3] p-[7px] text-red-600" />
	</button>;
};



// Chat list virtualization is delegated to react-virtuoso (see `messagesHTML` in
// SidebarChat). Streaming bubble, stall banner, generating-tool preview, loading
// indicator and error block are appended to the Virtuoso `data` array as kind-tagged
// items rather than rendered in a Footer — that way Virtuoso's followOutput pins
// the viewport to the latest content automatically.
//
// The old `ScrollToBottomContainer` (manual onScroll + scrollTop=scrollHeight) was
// removed because it kept every ChatBubble mounted at once, blowing through the
// listener-leak threshold on long histories.

// Custom Virtuoso Scroller: applies the chat container's overflow + flex CSS
// directly to the scroll element so horizontal overflow can't leak out.
// Horizontal padding (px-3) is NOT applied here — Virtuoso lays virtualized
// items out with absolute positioning, which ignores the scroller's padding.
// Per-item padding lives on the item wrapper in `itemContent` instead.
const ChatScroller = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
	function ChatScroller({ children, style, ...rest }, ref) {
		return (
			<div
				ref={ref}
				{...rest}
				// `@@vibe-chat-scroll-root`: opt out of the generic `.vibe-scope` 4px near-invisible
				// scrollbar (vibeide.css) — the chat list gets an always-visible, grabbable thumb.
				className='@@vibe-chat-scroll-root flex flex-col py-3 w-full h-full overflow-x-hidden overflow-y-auto'
				style={style}
			>
				{children}
			</div>
		);
	}
);

export const getRelative = (uri: URI, accessor: ReturnType<typeof useAccessor>) => {
	const workspaceContextService = accessor.get('IWorkspaceContextService');
	let path: string;
	const isInside = workspaceContextService.isInsideWorkspace(uri);
	if (isInside) {
		const f = workspaceContextService.getWorkspace().folders.find(f => uri.fsPath?.startsWith(f.uri.fsPath));
		if (f) { path = uri.fsPath.replace(f.uri.fsPath, ''); }
		else { path = uri.fsPath; }
	}
	else {
		path = uri.fsPath;
	}
	return path || undefined;
};

export const getFolderName = (pathStr: string) => {
	// 'unixify' path
	pathStr = pathStr.replace(/[/\\]+/g, '/'); // replace any / or \ or \\ with /
	const parts = pathStr.split('/'); // split on /
	// Filter out empty parts (the last element will be empty if path ends with /)
	const nonEmptyParts = parts.filter(part => part.length > 0);
	if (nonEmptyParts.length === 0) {return '/';} // Root directory
	if (nonEmptyParts.length === 1) {return nonEmptyParts[0] + '/';} // Only one folder
	// Get the last two parts
	const lastTwo = nonEmptyParts.slice(-2);
	return lastTwo.join('/') + '/';
};

export const getBasename = (pathStr: string, parts: number = 1) => {
	// 'unixify' path
	pathStr = pathStr.replace(/[/\\]+/g, '/'); // replace any / or \ or \\ with /
	const allParts = pathStr.split('/'); // split on /
	if (allParts.length === 0) {return pathStr;}
	return allParts.slice(-parts).join('/');
};



// Open file utility function
export const voidOpenFileFn = (
	uri: URI,
	accessor: ReturnType<typeof useAccessor>,
	range?: [number, number]
) => {
	const commandService = accessor.get('ICommandService');
	const editorService = accessor.get('ICodeEditorService');

	// Get editor selection from CodeSelection range
	let editorSelection = undefined;

	// If we have a selection, create an editor selection from the range
	if (range) {
		editorSelection = {
			startLineNumber: range[0],
			startColumn: 1,
			endLineNumber: range[1],
			endColumn: Number.MAX_SAFE_INTEGER,
		};
	}

	// open the file
	commandService.executeCommand('vscode.open', uri).then(() => {

		// select the text
		setTimeout(() => {
			if (!editorSelection) {return;}

			const editor = editorService.getActiveCodeEditor();
			if (!editor) {return;}

			editor.setSelection(editorSelection);
			editor.revealRange(editorSelection, ScrollType.Immediate);

		}, 50); // needed when document was just opened and needs to initialize

	});

};


export const SelectedFiles = (
	{ type, selections, setSelections, showProspectiveSelections, messageIdx, }:
		| { type: 'past'; selections: StagingSelectionItem[]; setSelections?: undefined; showProspectiveSelections?: undefined; messageIdx: number }
		| { type: 'staging'; selections: StagingSelectionItem[]; setSelections: ((newSelections: StagingSelectionItem[]) => void); showProspectiveSelections?: boolean; messageIdx?: number }
) => {

	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const modelReferenceService = accessor.get('IVibeideModelService');




	// state for tracking prospective files
	const { uri: currentURI } = useActiveURI();
	const [recentUris, setRecentUris] = useState<URI[]>([]);
	const maxRecentUris = 10;
	const maxProspectiveFiles = 3;
	useEffect(() => { // handle recent files
		if (!currentURI) {return;}
		setRecentUris(prev => {
			const withoutCurrent = prev.filter(uri => uri.fsPath !== currentURI.fsPath); // remove duplicates
			const withCurrent = [currentURI, ...withoutCurrent];
			return withCurrent.slice(0, maxRecentUris);
		});
	}, [currentURI]);
	const [prospectiveSelections, setProspectiveSelections] = useState<StagingSelectionItem[]>([]);


	// handle prospective files
	useEffect(() => {
		const computeRecents = async () => {
			const prospectiveURIs = recentUris
				.filter(uri => !selections.find(s => s.type === 'File' && s.uri.fsPath === uri.fsPath))
				.slice(0, maxProspectiveFiles);

			const answer: StagingSelectionItem[] = [];
			for (const uri of prospectiveURIs) {
				answer.push({
					type: 'File',
					uri: uri,
					language: (await modelReferenceService.getModelSafe(uri)).model?.getLanguageId() || 'plaintext',
					state: { wasAddedAsCurrentFile: false },
				});
			}
			return answer;
		};

		// add a prospective file if type === 'staging' and if the user is in a file, and if the file is not selected yet
		if (type === 'staging' && showProspectiveSelections) {
			computeRecents().then((a) => setProspectiveSelections(a));
		}
		else {
			setProspectiveSelections([]);
		}
	}, [recentUris, selections, type, showProspectiveSelections]);


	const allSelections = [...selections, ...prospectiveSelections];

	if (allSelections.length === 0) {
		return null;
	}

	return (
		<div className='flex items-center flex-wrap text-left relative gap-x-0.5 gap-y-1 pb-0.5'>

			{allSelections.map((selection, i) => {

				const isThisSelectionProspective = i > selections.length - 1;

				const thisKey = selection.type === 'CodeSelection' ? selection.type + selection.language + selection.range + selection.state.wasAddedAsCurrentFile + selection.uri.fsPath
					: selection.type === 'File' ? selection.type + selection.language + selection.state.wasAddedAsCurrentFile + selection.uri.fsPath
						: selection.type === 'Folder' ? selection.type + selection.language + selection.state + selection.uri.fsPath
							: i;

				const SelectionIcon = (
					selection.type === 'File' ? File
						: selection.type === 'Folder' ? Folder
							: selection.type === 'CodeSelection' ? Text
								: (undefined as never)
				);

				return <div // container for summarybox and code
					key={thisKey}
					className={`flex flex-col space-y-[1px]`}
				>
					{/* tooltip for file path */}
					<span className="truncate overflow-hidden text-ellipsis"
						data-tooltip-id='vibe-tooltip'
						data-tooltip-content={getRelative(selection.uri, accessor)}
						data-tooltip-place='top'
						data-tooltip-delay-show={3000}
					>
						{/* summarybox */}
						<div
							className={`
								flex items-center gap-1 relative
								px-1
								w-fit h-fit
								select-none
								text-xs text-nowrap
								border rounded-sm
								${isThisSelectionProspective ? 'bg-vibe-bg-1 text-vibe-fg-3 opacity-80' : 'bg-vibe-bg-1 hover:brightness-95 text-vibe-fg-1'}
								${isThisSelectionProspective
									? 'border-vibe-border-2'
									: 'border-vibe-border-1'
								}
								hover:border-vibe-border-1
								transition-all duration-150
							`}
							onClick={() => {
								if (type !== 'staging') {return;} // (never)
								if (isThisSelectionProspective) { // add prospective selection to selections
									setSelections([...selections, selection]);
								}
								else if (selection.type === 'File') { // open files
									voidOpenFileFn(selection.uri, accessor);

									const wasAddedAsCurrentFile = selection.state.wasAddedAsCurrentFile;
									if (wasAddedAsCurrentFile) {
										// make it so the file is added permanently, not just as the current file
										const newSelection: StagingSelectionItem = { ...selection, state: { ...selection.state, wasAddedAsCurrentFile: false } };
										setSelections([
											...selections.slice(0, i),
											newSelection,
											...selections.slice(i + 1)
										]);
									}
								}
								else if (selection.type === 'CodeSelection') {
									voidOpenFileFn(selection.uri, accessor, selection.range);
								}
								else if (selection.type === 'Folder') {
									// TODO!!! reveal in tree
								}
							}}
						>
							{<SelectionIcon size={10} />}

							{ // file name and range
								getBasename(selection.uri.fsPath)
								+ (selection.type === 'CodeSelection' ? ` (${selection.range[0]}-${selection.range[1]})` : '')
							}

							{selection.type === 'File' && selection.state.wasAddedAsCurrentFile && messageIdx === undefined && currentURI?.fsPath === selection.uri.fsPath ?
								<span className={`text-[8px] opacity-60 text-vibe-fg-4`}>
									{`(Current File)`}
								</span>
								: null
							}

							{type === 'staging' && !isThisSelectionProspective ? // X button
								<div // box for making it easier to click
									className='cursor-pointer z-1 self-stretch flex items-center justify-center'
									onClick={(e) => {
										e.stopPropagation(); // don't open/close selection
										if (type !== 'staging') {return;}
										setSelections([...selections.slice(0, i), ...selections.slice(i + 1)]);
									}}
								>
									<IconX
										className='stroke-[2]'
										size={10}
									/>
								</div>
								: <></>
							}
						</div>
					</span>
				</div>;

			})}


		</div>

	);
};


type ToolHeaderParams = {
	icon?: React.ReactNode;
	title: React.ReactNode;
	desc1: React.ReactNode;
	desc1OnClick?: () => void;
	desc2?: React.ReactNode;
	isError?: boolean;
	info?: string;
	desc1Info?: string;
	isRejected?: boolean;
	numResults?: number;
	hasNextPage?: boolean;
	children?: React.ReactNode;
	bottomChildren?: React.ReactNode;
	onClick?: () => void;
	desc2OnClick?: () => void;
	isOpen?: boolean;
	className?: string;
};

const ToolHeaderWrapper = ({
	icon,
	title,
	desc1,
	desc1OnClick,
	desc1Info,
	desc2,
	numResults,
	hasNextPage,
	children,
	info,
	bottomChildren,
	isError,
	onClick,
	desc2OnClick,
	isOpen,
	isRejected,
	className, // applies to the main content
}: ToolHeaderParams) => {

	const [isOpen_, setIsOpen] = useState(false);
	const isExpanded = isOpen !== undefined ? isOpen : isOpen_;

	const isDropdown = children !== undefined; // null ALLOWS dropdown
	const isClickable = !!(isDropdown || onClick);

	const isDesc1Clickable = !!desc1OnClick;

	const desc1HTML = <span
		className={`text-vibe-fg-4 text-xs italic truncate ml-2
			${isDesc1Clickable ? 'cursor-pointer hover:brightness-125 transition-all duration-150' : ''}
		`}
		onClick={desc1OnClick}
		{...desc1Info ? {
			'data-tooltip-id': 'vibe-tooltip',
			'data-tooltip-content': desc1Info,
			'data-tooltip-place': 'top',
			'data-tooltip-delay-show': 1000,
		} : {}}
	>{desc1}</span>;

	return (<div className=''>
		<div className={`w-full border border-vibe-border-3 rounded px-2 py-1 bg-vibe-bg-3 overflow-hidden ${className}`}>
			{/* header */}
			<div className={`select-none flex items-center min-h-[24px]`}>
				<div className={`flex items-center w-full gap-x-2 overflow-hidden justify-between ${isRejected ? 'line-through' : ''}`}>
					{/* left */}
					<div // container for if desc1 is clickable
						className='ml-1 flex items-center overflow-hidden'
					>
						{/* title eg "> Edited File" */}
						<div className={`
							flex items-center min-w-0 overflow-hidden grow
							${isClickable ? 'cursor-pointer hover:brightness-125 transition-all duration-150' : ''}
						`}
							onClick={() => {
								if (isDropdown) { setIsOpen(v => !v); }
								if (onClick) { onClick(); }
							}}
						>
							{isDropdown && (<ChevronRight
								className={`
								text-vibe-fg-3 mr-0.5 h-4 w-4 flex-shrink-0 transition-transform duration-100 ease-[cubic-bezier(0.4,0,0.2,1)]
								${isExpanded ? 'rotate-90' : ''}
							`}
							/>)}
							<span className="text-vibe-fg-3 flex-shrink-0">{title}</span>

							{!isDesc1Clickable && desc1HTML}
						</div>
						{isDesc1Clickable && desc1HTML}
					</div>

					{/* right */}
					<div className="flex items-center gap-x-2 flex-shrink-0">

						{info && <CircleEllipsis
							className='ml-2 text-vibe-fg-4 opacity-60 flex-shrink-0'
							size={14}
							data-tooltip-id='vibe-tooltip'
							data-tooltip-content={info}
							data-tooltip-place='top-end'
						/>}

						{isError && <AlertTriangle
							className='text-vibe-warning opacity-90 flex-shrink-0'
							size={14}
							data-tooltip-id='vibe-tooltip'
							data-tooltip-content={'Error running tool'}
							data-tooltip-place='top'
						/>}
						{isRejected && <Ban
							className='text-vibe-fg-4 opacity-90 flex-shrink-0'
							size={14}
							data-tooltip-id='vibe-tooltip'
							data-tooltip-content={'Canceled'}
							data-tooltip-place='top'
						/>}
						{desc2 && <span className="text-vibe-fg-4 text-xs" onClick={desc2OnClick}>
							{desc2}
						</span>}
						{numResults !== undefined && (
							<span className="text-vibe-fg-4 text-xs ml-auto mr-1">
								{`${numResults}${hasNextPage ? '+' : ''} result${numResults !== 1 ? 's' : ''}`}
							</span>
						)}
					</div>
				</div>
			</div>
			{/* children */}
			{<div
				className={`overflow-hidden transition-all duration-200 ease-in-out ${isExpanded ? 'opacity-100 py-1' : 'max-h-0 opacity-0'}
					text-vibe-fg-4 rounded-sm overflow-x-auto
				  `}
			//    bg-black bg-opacity-10 border border-vibe-border-4 border-opacity-50
			>
				{children}
			</div>}
		</div>
		{bottomChildren}
	</div>);
};



const EditTool = ({ toolMessage, threadId, messageIdx, content }: Parameters<ResultWrapper<'edit_file' | 'rewrite_file'>>[0] & { content: string }) => {
	const accessor = useAccessor();
	const isError = false;
	const isRejected = toolMessage.type === 'rejected';

	const title = getTitle(toolMessage);

	const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
	const icon = null;

	const { rawParams, params, name } = toolMessage;
	const desc1OnClick = () => voidOpenFileFn(params.uri, accessor);
	const componentParams: ToolHeaderParams = { title, desc1, desc1OnClick, desc1Info, isError, icon, isRejected, };


	const editToolType = toolMessage.name === 'edit_file' ? 'diff' : 'rewrite';
	if (toolMessage.type === 'running_now' || toolMessage.type === 'tool_request') {
		componentParams.children = <ToolChildrenWrapper className='bg-vibe-bg-3'>
			<EditToolChildren
				uri={params.uri}
				code={content}
				type={editToolType}
			/>
		</ToolChildrenWrapper>;
		// JumpToFileButton removed in favor of FileLinkText
	}
	else if (toolMessage.type === 'success' || toolMessage.type === 'rejected' || toolMessage.type === 'tool_error') {
		// add apply box
		const applyBoxId = getApplyBoxId({
			threadId: threadId,
			messageIdx: messageIdx,
			tokenIdx: 'N/A',
		});
		componentParams.desc2 = <EditToolHeaderButtons
			applyBoxId={applyBoxId}
			uri={params.uri}
			codeStr={content}
			toolName={name}
			threadId={threadId}
		/>;

		// add children
		componentParams.children = <ToolChildrenWrapper className='bg-vibe-bg-3'>
			<EditToolChildren
				uri={params.uri}
				code={content}
				type={editToolType}
			/>
		</ToolChildrenWrapper>;

		if (toolMessage.type === 'success' || toolMessage.type === 'rejected') {
			const { result } = toolMessage;
			componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenLintErrors}>
				{result?.lintErrors?.map((error, i) => (
					<div key={i} className='whitespace-nowrap'>Lines {error.startLineNumber}-{error.endLineNumber}: {error.message}</div>
				))}
			</BottomChildren>;
		}
		else if (toolMessage.type === 'tool_error') {
			// error
			const { result } = toolMessage;
			componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
				<CodeChildren>
					{result}
				</CodeChildren>
			</BottomChildren>;
		}
	}

	return <ToolHeaderWrapper {...componentParams} />;
};

const SimplifiedToolHeader = ({
	title,
	children,
}: {
	title: string;
	children?: React.ReactNode;
}) => {
	const [isOpen, setIsOpen] = useState(false);
	const isDropdown = children !== undefined;
	return (
		<div>
			<div className="w-full">
				{/* header */}
				<div
					className={`select-none flex items-center min-h-[24px] ${isDropdown ? 'cursor-pointer' : ''}`}
					onClick={() => {
						if (isDropdown) { setIsOpen(v => !v); }
					}}
				>
					{isDropdown && (
						<ChevronRight
							className={`text-vibe-fg-3 mr-0.5 h-4 w-4 flex-shrink-0 transition-transform duration-100 ease-[cubic-bezier(0.4,0,0.2,1)] ${isOpen ? 'rotate-90' : ''}`}
						/>
					)}
					<div className="flex items-center w-full overflow-hidden">
						<span className="text-vibe-fg-3">{title}</span>
					</div>
				</div>
				{/* children */}
				{<div
					className={`overflow-hidden transition-all duration-200 ease-in-out ${isOpen ? 'opacity-100' : 'max-h-0 opacity-0'} text-vibe-fg-4`}
				>
					{children}
				</div>}
			</div>
		</div>
	);
};


// Highlights `/skill:name` inline. Matches only when the slash starts the message or
// follows whitespace — avoids false positives on paths (`/usr/bin`), URLs, or code
// fragments. Backend (convertToLLMMessageService) only expands `/skill:NAME`, so plain
// `/foo` is intentionally NOT highlighted to avoid promising behavior that won't fire.
// Returns alternating plain-string and pill spans; rendered text is identical to input.
const SLASH_COMMAND_RE = /(^|\s)(\/skill:[\w.-]+)/g;
// Inline fallback for builds where vibeide.css hasn't been re-bundled. Inline wins
// specificity and matches what util/inputs.tsx ships for the input overlay.
// Geometry-neutral outline: same shape as the overlay version, no border/padding so
// inline char-advance stays identical to the textarea (caret alignment depends on it).
const SKILL_PILL_INLINE_STYLE: React.CSSProperties = {
	background: 'var(--vibe-skill-pill-bg, rgba(3, 237, 249, 0.16))',
	color: 'var(--vibe-skill-pill-fg, #03edf9)',
	borderRadius: 3,
	boxShadow: 'inset 0 0 0 1px var(--vibe-skill-pill-border, rgba(3, 237, 249, 0.40))',
	textShadow: 'var(--vibe-skill-pill-glow, none)',
};
const renderWithSkillHighlights = (text: string): React.ReactNode => {
	if (!text || !text.includes('/')) {return text;}
	const out: React.ReactNode[] = [];
	let lastIdx = 0;
	let m: RegExpExecArray | null;
	SLASH_COMMAND_RE.lastIndex = 0;
	while ((m = SLASH_COMMAND_RE.exec(text)) !== null) {
		const [, leading, cmd] = m;
		const cmdStart = m.index + leading.length;
		if (cmdStart > lastIdx) {out.push(text.slice(lastIdx, cmdStart));}
		out.push(<span key={cmdStart} className="vibe-skill-pill" style={SKILL_PILL_INLINE_STYLE}>{cmd}</span>);
		lastIdx = cmdStart + cmd.length;
	}
	if (lastIdx === 0) {return text;}
	if (lastIdx < text.length) {out.push(text.slice(lastIdx));}
	return <>{out}</>;
};


const UserMessageComponent = ({ chatMessage, messageIdx, isCheckpointGhost, currCheckpointIdx, _scrollToBottom }: { chatMessage: ChatMessage & { role: 'user' }; messageIdx: number; currCheckpointIdx: number | undefined; isCheckpointGhost: boolean; _scrollToBottom: (() => void) | null }) => {

	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');

	// Subscribe to thread state changes properly
	const chatThreadsState = useChatThreadsState();
	const currentThreadId = chatThreadsState.currentThreadId;

	// global state
	let isBeingEdited = false;
	let stagingSelections: StagingSelectionItem[] = [];
	let setIsBeingEdited = (_: boolean) => { };
	let setStagingSelections = (_: StagingSelectionItem[]) => { };

	if (messageIdx !== undefined) {
		const _state = chatThreadsService.getCurrentMessageState(messageIdx);
		isBeingEdited = _state.isBeingEdited;
		stagingSelections = _state.stagingSelections;
		setIsBeingEdited = (v) => chatThreadsService.setCurrentMessageState(messageIdx, { isBeingEdited: v });
		setStagingSelections = (s) => chatThreadsService.setCurrentMessageState(messageIdx, { stagingSelections: s });
	}


	// local state
	const mode: ChatBubbleMode = isBeingEdited ? 'edit' : 'display';
	const [isFocused, setIsFocused] = useState(false);
	const [isHovered, setIsHovered] = useState(false);
	const [isDisabled, setIsDisabled] = useState(false);
	const [textAreaRefState, setTextAreaRef] = useState<HTMLTextAreaElement | null>(null);
	const textAreaFnsRef = useRef<TextAreaFns | null>(null);
	// initialize on first render, and when edit was just enabled
	const _mustInitialize = useRef(true);
	const _justEnabledEdit = useRef(false);
	useEffect(() => {
		const canInitialize = mode === 'edit' && textAreaRefState;
		const shouldInitialize = _justEnabledEdit.current || _mustInitialize.current;
		if (canInitialize && shouldInitialize) {
			setStagingSelections(
				(chatMessage.selections || []).map(s => { // quick hack so we dont have to do anything more
					if (s.type === 'File') {return { ...s, state: { ...s.state, wasAddedAsCurrentFile: false, } };}
					else {return s;}
				})
			);

			if (textAreaFnsRef.current)
				{textAreaFnsRef.current.setValue(chatMessage.displayContent || '');}

			textAreaRefState.focus();

			_justEnabledEdit.current = false;
			_mustInitialize.current = false;
		}

	}, [chatMessage, mode, textAreaRefState, setStagingSelections]);

	const onOpenEdit = () => {
		setIsBeingEdited(true);
		chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx);
		_justEnabledEdit.current = true;
	};
	const onCloseEdit = () => {
		setIsFocused(false);
		setIsHovered(false);
		setIsBeingEdited(false);
		chatThreadsService.setCurrentlyFocusedMessageIdx(undefined);

	};

	const EditSymbol = mode === 'display' ? Pencil : X;


	let chatbubbleContents: React.ReactNode;
	if (mode === 'display') {
		const hasImages = chatMessage.images && chatMessage.images.length > 0;
		const hasPDFs = chatMessage.pdfs && chatMessage.pdfs.length > 0;
		const hasAttachments = hasImages || hasPDFs;

		chatbubbleContents = <>
			<SelectedFiles type='past' messageIdx={messageIdx} selections={chatMessage.selections || []} />
			{hasImages && (
				<div className="px-0.5 py-2">
					<ImageMessageRenderer
						images={chatMessage.images}
					/>
				</div>
			)}
			{hasPDFs && (
				<div className="px-0.5 py-2">
					<PDFMessageRenderer
						pdfs={chatMessage.pdfs}
					/>
				</div>
			)}
			{chatMessage.displayContent && (
				<span className='px-0.5'>{renderWithSkillHighlights(chatMessage.displayContent)}</span>
			)}
		</>;
	}
	else if (mode === 'edit') {

		const onSubmit = async () => {

			if (isDisabled) {return;}
			if (!textAreaRefState) {return;}
			if (messageIdx === undefined) {return;}

			// cancel any streams on this thread - use subscribed state
			const threadId = currentThreadId;

			// Defensive check: verify the message is still a user message before editing
			const thread = chatThreadsState.allThreads[threadId];
			if (!thread || !thread.messages || thread.messages[messageIdx]?.role !== 'user') {
				vibeLog.error('SidebarChat', 'Error while editing message: Message is not a user message or no longer exists');
				setIsBeingEdited(false);
				chatThreadsService.setCurrentlyFocusedMessageIdx(undefined);
				return;
			}

			await chatThreadsService.abortRunning(threadId);

			// update state
			setIsBeingEdited(false);
			chatThreadsService.setCurrentlyFocusedMessageIdx(undefined);

			// stream the edit
			const userMessage = textAreaRefState.value;
			try {
				await chatThreadsService.editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId });
			} catch (e) {
				vibeLog.error('SidebarChat', 'Error while editing message:', e);
			}
			await chatThreadsService.focusCurrentChat();
			requestAnimationFrame(() => _scrollToBottom?.());
		};

		const onAbort = async () => {
			// use subscribed state
			const threadId = currentThreadId;
			await chatThreadsService.abortRunning(threadId);
		};

		const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Escape') {
				onCloseEdit();
			}
			if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
				onSubmit();
			}
		};

		if (!chatMessage.content) { // don't show if empty and not loading (if loading, want to show).
			return null;
		}

		chatbubbleContents = <VibeChatArea
			featureName='Chat'
			showChatHistoryControl={false}
			onSubmit={onSubmit}
			onAbort={onAbort}
			isStreaming={false}
			isDisabled={isDisabled}
			showSelections={true}
			showProspectiveSelections={false}
			selections={stagingSelections}
			setSelections={setStagingSelections}
		>
			<VibeInputBox2
				enableAtToMention
				appearance="chatDark"
				ref={setTextAreaRef}
				className='min-h-[60px] px-3 py-3 rounded-2xl'
				placeholder={chatS.placeholderFull}
				onChangeText={(text) => setIsDisabled(!text)}
				onFocus={() => {
					setIsFocused(true);
					chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx);
				}}
				onBlur={() => {
					setIsFocused(false);
				}}
				onKeyDown={onKeyDown}
				fnsRef={textAreaFnsRef}
				multiline={true}
			/>
		</VibeChatArea>;
	}

	const isMsgAfterCheckpoint = currCheckpointIdx !== undefined && currCheckpointIdx === messageIdx - 1;

	return <div
		// align chatbubble accoridng to role
		className={`
        relative ml-auto
        ${mode === 'edit' ? 'w-full max-w-full'
				: mode === 'display' ? `self-end w-fit max-w-full whitespace-pre-wrap` : '' // user words should be pre
			}

        ${isCheckpointGhost && !isMsgAfterCheckpoint ? 'opacity-50 pointer-events-none' : ''}
    `}
		onMouseEnter={() => setIsHovered(true)}
		onMouseLeave={() => setIsHovered(false)}
	>
		<div
			// style chatbubble according to role
			className={`
            text-left rounded-lg max-w-full
            ${mode === 'edit' ? ''
					: mode === 'display' ? 'p-2 flex flex-col bg-vibe-bg-1 text-vibe-fg-1 overflow-x-auto cursor-pointer select-text' : ''
				}
        `}
			onClick={() => {
				if (mode !== 'display') {return;}
				// Don't open edit mode if the user is selecting text inside the bubble.
				const sel = typeof window !== 'undefined' ? window.getSelection() : null;
				if (sel && !sel.isCollapsed && sel.toString().length > 0) {return;}
				onOpenEdit();
			}}
		>
			{chatbubbleContents}
		</div>

		{mode === 'display' && <ChatTimestamp ts={chatMessage.createdAt} align='right' />}

		<div
			className="absolute -top-1 -right-1 translate-x-0 -translate-y-0 z-1 flex items-center gap-1"
		>
			{/* Pin-context: keep this message verbatim through context truncation. Shown on
			    hover, or always while pinned so the state stays visible. */}
			{mode === 'display' && (
				<Pin
					size={18}
					title={chatMessage.pinned ? 'Открепить сообщение' : 'Закрепить сообщение (не обрезать при сжатии контекста)'}
					className={`
                    cursor-pointer
                    p-[2px]
                    bg-vibe-bg-1 border border-vibe-border-1 rounded-md
                    transition-opacity duration-200 ease-in-out
                    ${chatMessage.pinned ? 'opacity-100 fill-current' : isHovered ? 'opacity-100 text-vibe-fg-3' : 'opacity-0'}
                `}
					style={chatMessage.pinned ? { color: 'var(--vscode-vibeide-chatGroup-activeBorder, #fc28a8)' } : undefined}
					onClick={(e) => {
						e.stopPropagation();
						chatThreadsService.toggleMessagePinned({ threadId: currentThreadId, messageIdx });
					}}
				/>
			)}
			<EditSymbol
				size={18}
				className={`
                    cursor-pointer
                    p-[2px]
                    bg-vibe-bg-1 border border-vibe-border-1 rounded-md
                    transition-opacity duration-200 ease-in-out
                    ${isHovered || (isFocused && mode === 'edit') ? 'opacity-100' : 'opacity-0'}
                `}
				onClick={() => {
					if (mode === 'display') {
						onOpenEdit();
					} else if (mode === 'edit') {
						onCloseEdit();
					}
				}}
			/>
		</div>


	</div>;

};

const SmallProseWrapper = ({ children }: { children: React.ReactNode }) => {
	return <div className='
select-text
text-vibe-fg-4
prose
prose-sm
break-words
max-w-none
leading-snug
text-[13px]

[&>:first-child]:!mt-0
[&>:last-child]:!mb-0

prose-h1:text-[14px]
prose-h1:my-4

prose-h2:text-[13px]
prose-h2:my-4

prose-h3:text-[13px]
prose-h3:my-3

prose-h4:text-[13px]
prose-h4:my-2

prose-p:my-2
prose-p:leading-snug
prose-hr:my-2

prose-ul:my-2
prose-ul:pl-4
prose-ul:list-outside
prose-ul:list-disc
prose-ul:leading-snug


prose-ol:my-2
prose-ol:pl-4
prose-ol:list-outside
prose-ol:list-decimal
prose-ol:leading-snug

marker:text-inherit

prose-blockquote:pl-2
prose-blockquote:my-2

prose-code:text-vibe-fg-3
prose-code:text-[12px]
prose-code:before:content-none
prose-code:after:content-none

prose-pre:text-[12px]
prose-pre:p-2
prose-pre:my-2

prose-table:text-[13px]
'>
		{children}
	</div>;
};

const ProseWrapper = ({ children }: { children: React.ReactNode }) => {
	return <div className='
select-text
text-vibe-fg-2
prose
prose-sm
break-words
prose-p:block
prose-hr:my-4
prose-pre:my-2
marker:text-inherit
prose-ol:list-outside
prose-ol:list-decimal
prose-ul:list-outside
prose-ul:list-disc
prose-li:my-0
prose-code:before:content-none
prose-code:after:content-none
prose-headings:prose-sm
prose-headings:font-bold

prose-p:leading-normal
prose-ol:leading-normal
prose-ul:leading-normal

max-w-none
'
	>
		{children}
	</div>;
};
const AssistantMessageComponent = React.memo(({ chatMessage, isCheckpointGhost, isCommitted, messageIdx }: { chatMessage: ChatMessage & { role: 'assistant' }; isCheckpointGhost: boolean; messageIdx: number; isCommitted: boolean }) => {

	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');

	// Render-layer safety net: scrub any complete tool-call tags that leaked into
	// user-visible text (e.g. a 2nd tool emission past the parser's first, or a
	// chat mode without the extractGrammar wrapper). stripUnclaimedToolTags swaps
	// `<run_command>…</run_command>` for a polite placeholder. Memoized so it only
	// recomputes when the underlying text changes.
	const reasoningStr = useMemo(() => {
		const r = chatMessage.reasoning?.trim() || null;
		return r ? stripUnclaimedToolTags(r) : null;
	}, [chatMessage.reasoning]);
	const displayContent = useMemo(() => stripUnclaimedToolTags(chatMessage.displayContent || ''), [chatMessage.displayContent]);
	const hasReasoning = !!reasoningStr;
	const isDoneReasoning = !!chatMessage.displayContent;
	const thread = chatThreadsService.getCurrentThread();


	const chatMessageLocation: ChatMessageLocation = useMemo(() => ({
		threadId: thread.id,
		messageIdx: messageIdx,
	}), [thread.id, messageIdx]);

	// Premature-stop affordance: the agent appends a notice (agentStoppedNoToolCall) when it
	// halts because the model returned text with no tool call and Autopilot is off. Offer a
	// one-click «Продолжить» — but only while this is still the thread's last message and the
	// thread is idle (so historical notices don't keep a live button).
	const threadIsRunning = useChatThreadsStreamState(thread.id)?.isRunning;
	const threadIsIdle = threadIsRunning === undefined || threadIsRunning === 'idle';
	const isLastMessage = messageIdx === (thread.messages.length - 1);
	const showContinueAffordance = chatMessage.agentStoppedNoToolCall === true && isLastMessage && threadIsIdle && !isCheckpointGhost;

	const isEmpty = !chatMessage.displayContent && !chatMessage.reasoning;
	if (isEmpty) {return null;}

	return <>
		{/* reasoning token */}
		{hasReasoning &&
			<div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
				<ReasoningWrapper isDoneReasoning={isDoneReasoning} isStreaming={!isCommitted}>
					<SmallProseWrapper>
						<ChatMarkdownRender
							string={reasoningStr}
							chatMessageLocation={chatMessageLocation}
							isApplyEnabled={false}
							isLinkDetectionEnabled={true}
						/>
					</SmallProseWrapper>
				</ReasoningWrapper>
			</div>
		}

		{/* assistant message */}
		{displayContent &&
			<div
				className={`select-text ${isCheckpointGhost ? 'opacity-50' : ''} ${!isCommitted ? 'streaming-content-chunk' : ''}`}
				role={!isCommitted ? "status" : undefined}
				aria-live={!isCommitted ? "polite" : undefined}
				aria-atomic={!isCommitted ? "false" : undefined}
			>
				<ProseWrapper>
					<ChatMarkdownRender
						string={displayContent}
						chatMessageLocation={chatMessageLocation}
						isApplyEnabled={true}
						isLinkDetectionEnabled={true}
					/>
					{!isCommitted && <TypingCursor className="text-vibe-fg-2" aria-label={chatS.streamingContentAria} />}
				</ProseWrapper>
			</div>
		}

		{/* timestamp shown once after the assistant message; placeholder while streaming, real value after first chunk commits */}
		{(hasReasoning || chatMessage.displayContent) && (
			isCommitted
				? <ChatTimestamp ts={chatMessage.createdAt} align='left' />
				: <ChatTimestamp ts={chatMessage.createdAt} align='left' streaming />
		)}

		{/* one-click resume when the agent stopped on a text-only turn (no tool call) */}
		{showContinueAffordance && (
			<div className="mt-1.5">
				<button
					type="button"
					title={chatS.agentContinueTitle}
					aria-label={chatS.agentContinueLabel}
					onClick={() => { void chatThreadsService.addUserMessageAndStreamResponse({ userMessage: 'продолжи', threadId: thread.id }); }}
					className="px-3 py-1.5 text-xs rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/40"
				>
					{chatS.agentContinueLabel}
				</button>
			</div>
		)}
	</>;

}, (prev, next) => {
	// Custom comparison: only re-render if message content, checkpoint state, or committed state changes
	return prev.chatMessage.displayContent === next.chatMessage.displayContent &&
		prev.chatMessage.reasoning === next.chatMessage.reasoning &&
		prev.isCheckpointGhost === next.isCheckpointGhost &&
		prev.isCommitted === next.isCommitted &&
		prev.messageIdx === next.messageIdx;
});

const ReasoningWrapper = ({ isDoneReasoning, isStreaming, children }: { isDoneReasoning: boolean; isStreaming: boolean; children: React.ReactNode }) => {
	const isDone = isDoneReasoning || !isStreaming;
	const isWriting = !isDone;
	const [isOpen, setIsOpen] = useState(false);
	return <ToolHeaderWrapper title={chatS.reasoningHeader} desc1={isWriting ? <IconLoading state="thinking" inline /> : ''} isOpen={isOpen} onClick={() => setIsOpen(v => !v)}>
		<ToolChildrenWrapper>
			<div className='!select-text cursor-auto'>
				{children}
			</div>
		</ToolChildrenWrapper>
	</ToolHeaderWrapper>;
};




// should either be past or "-ing" tense, not present tense. Eg. when the LLM searches for something, the user expects it to say "I searched for X" or "I am searching for X". Not "I search X".

const loadingTitleWrapper = (item: React.ReactNode): React.ReactNode => {
	return <span className='flex items-center flex-nowrap gap-1'>
		{item}
		<IconLoading state="processing" inline className='w-3 text-sm' />
	</span>;
};

const titleOfBuiltinToolName = {
	'read_file': { done: 'Read file', proposed: 'Read file', running: loadingTitleWrapper('Reading file') },
	'ls_dir': { done: 'Inspected folder', proposed: 'Inspect folder', running: loadingTitleWrapper('Inspecting folder') },
	'get_dir_tree': { done: 'Inspected folder tree', proposed: 'Inspect folder tree', running: loadingTitleWrapper('Inspecting folder tree') },
	'search_pathnames_only': { done: 'Searched by file name', proposed: 'Search by file name', running: loadingTitleWrapper('Searching by file name') },
	'search_for_files': { done: 'Searched', proposed: 'Search', running: loadingTitleWrapper('Searching') },
	'create_file_or_folder': { done: `Created`, proposed: `Create`, running: loadingTitleWrapper(`Creating`) },
	'delete_file_or_folder': { done: `Deleted`, proposed: `Delete`, running: loadingTitleWrapper(`Deleting`) },
	'edit_file': { done: `Edited file`, proposed: 'Edit file', running: loadingTitleWrapper('Editing file') },
	'rewrite_file': { done: `Wrote file`, proposed: 'Write file', running: loadingTitleWrapper('Writing file') },
	'run_command': { done: `Ran terminal`, proposed: 'Run terminal', running: loadingTitleWrapper('Running terminal') },
	'run_persistent_command': { done: `Ran terminal`, proposed: 'Run terminal', running: loadingTitleWrapper('Running terminal') },

	'open_persistent_terminal': { done: `Opened terminal`, proposed: 'Open terminal', running: loadingTitleWrapper('Opening terminal') },
	'kill_persistent_terminal': { done: `Killed terminal`, proposed: 'Kill terminal', running: loadingTitleWrapper('Killing terminal') },

	'read_lint_errors': { done: `Read lint errors`, proposed: 'Read lint errors', running: loadingTitleWrapper('Reading lint errors') },
	'search_in_file': { done: 'Searched in file', proposed: 'Search in file', running: loadingTitleWrapper('Searching in file') },
	'web_search': { done: 'Searched the web', proposed: 'Search the web', running: loadingTitleWrapper('Searching the web') },
	'browse_url': { done: 'Fetched web page', proposed: 'Fetch web page', running: loadingTitleWrapper('Fetching web page') },
	'vibe_complete': { done: 'Завершил ход', proposed: 'Завершить ход', running: loadingTitleWrapper('Завершает ход') },
} as const satisfies Record<BuiltinToolName, { done: any; proposed: any; running: any }>;


const getTitle = (toolMessage: Pick<ChatMessage & { role: 'tool' }, 'name' | 'type' | 'mcpServerName'>): React.ReactNode => {
	const t = toolMessage;

	// non-built-in title
	if (!builtinToolNames.includes(t.name as BuiltinToolName)) {
		// descriptor of Running or Ran etc
		const descriptor =
			t.type === 'success' ? 'Called'
				: t.type === 'running_now' ? 'Calling'
					: t.type === 'tool_request' ? 'Call'
						: t.type === 'rejected' ? 'Call'
							: t.type === 'invalid_params' ? 'Call'
								: t.type === 'tool_error' ? 'Call'
									: 'Call';


		const title = `${descriptor} ${toolMessage.mcpServerName || 'MCP'}`;
		if (t.type === 'running_now' || t.type === 'tool_request')
			{return loadingTitleWrapper(title);}
		return title;
	}

	// built-in title
	else {
		const toolName = t.name as BuiltinToolName;
		const titles = titleOfBuiltinToolName[toolName];
		// titleOfBuiltinToolName can lag behind BuiltinToolName when tools are
		// added to the type but not to the title map — fall back to the raw
		// name instead of crashing the React tree.
		if (!titles) {return t.name;}
		if (t.type === 'success') {return titles.done;}
		if (t.type === 'running_now') {return titles.running;}
		return titles.proposed;
	}
};


const toolNameToDesc = (toolName: BuiltinToolName, _toolParams: BuiltinToolCallParams[BuiltinToolName] | undefined, accessor: ReturnType<typeof useAccessor>): {
	desc1: React.ReactNode;
	desc1Info?: string;
} => {

	if (!_toolParams) {
		return { desc1: '', };
	}

	const x = {
		'read_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['read_file'];
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'ls_dir': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['ls_dir'];
			return {
				desc1: getFolderName(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'search_pathnames_only': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_pathnames_only'];
			return {
				desc1: `"${toolParams.query}"`,
			};
		},
		'search_for_files': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_for_files'];
			return {
				desc1: `"${toolParams.query}"`,
			};
		},
		'search_in_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_in_file'];
			// File goes in the prominent slot (matches the "Searched in file" title); the query is a
			// detail. Previously the query sat in desc1 and read like a file path (e.g. `"\.select\("`).
			return {
				desc1: getRelative(toolParams.uri, accessor),
				desc1Info: `"${toolParams.query}"`,
			};
		},
		'create_file_or_folder': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['create_file_or_folder'];
			return {
				desc1: toolParams.isFolder ? getFolderName(toolParams.uri.fsPath) ?? '/' : getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'delete_file_or_folder': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['delete_file_or_folder'];
			return {
				desc1: toolParams.isFolder ? getFolderName(toolParams.uri.fsPath) ?? '/' : getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'rewrite_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['rewrite_file'];
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'edit_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['edit_file'];
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'run_command': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['run_command'];
			return {
				desc1: `"${toolParams.command}"`,
			};
		},
		'run_persistent_command': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['run_persistent_command'];
			return {
				desc1: `"${toolParams.command}"`,
			};
		},
		'open_persistent_terminal': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['open_persistent_terminal'];
			return { desc1: '' };
		},
		'kill_persistent_terminal': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['kill_persistent_terminal'];
			return { desc1: toolParams.persistentTerminalId };
		},
		'get_dir_tree': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['get_dir_tree'];
			return {
				desc1: getFolderName(toolParams.uri.fsPath) ?? '/',
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'read_lint_errors': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['read_lint_errors'];
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'web_search': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['web_search'];
			return {
				desc1: `"${toolParams.query}"`,
			};
		},
		'browse_url': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['browse_url'];
			return {
				desc1: toolParams.url,
				desc1Info: new URL(toolParams.url).hostname,
			};
		}
	};

	try {
		return x[toolName]?.() || { desc1: '' };
	}
	catch {
		return { desc1: '' };
	}
};

const ToolRequestAcceptRejectButtons = ({ toolName }: { toolName: ToolName }) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const metricsService = accessor.get('IMetricsService');
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const vibeSettingsState = useSettingsState();

	// Subscribe to thread state changes properly
	const chatThreadsState = useChatThreadsState();
	const currentThreadId = chatThreadsState.currentThreadId;

	const onAccept = useCallback(() => {
		try { // this doesn't need to be wrapped in try/catch anymore
			// use subscribed state
			chatThreadsService.approveLatestToolRequest(currentThreadId);
			metricsService.capture('Tool Request Accepted', {});
		} catch (e) { vibeLog.error('SidebarChat', 'Error while approving message in chat:', e); }
	}, [chatThreadsService, metricsService, currentThreadId]);

	const onReject = useCallback(() => {
		try {
			// use subscribed state
			chatThreadsService.rejectLatestToolRequest(currentThreadId);
		} catch (e) { vibeLog.error('SidebarChat', 'Error while approving message in chat:', e); }
		metricsService.capture('Tool Request Rejected', {});
	}, [chatThreadsService, metricsService, currentThreadId]);

	const approveButton = (
		<button
			onClick={onAccept}
			className={`
                px-2 py-1
                bg-[var(--vscode-button-background)]
                text-[var(--vscode-button-foreground)]
                hover:bg-[var(--vscode-button-hoverBackground)]
                rounded
                text-sm font-medium
            `}
		>
			Approve
		</button>
	);

	const cancelButton = (
		<button
			onClick={onReject}
			className={`
                px-2 py-1
                bg-[var(--vscode-button-secondaryBackground)]
                text-[var(--vscode-button-secondaryForeground)]
                hover:bg-[var(--vscode-button-secondaryHoverBackground)]
                rounded
                text-sm font-medium
            `}
		>
			Cancel
		</button>
	);

	const approvalType = isABuiltinToolName(toolName) ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools';
	const approvalToggle = approvalType ? <div key={approvalType} className="flex items-center ml-2 gap-x-1" title={'Deletes and other high-risk edits always require confirmation unless Autopilot is enabled (next to the model). This switch only auto-approves lower-risk steps when turned on.'}>
		<ToolApprovalTypeSwitch size='xs' approvalType={approvalType} desc={`Auto ${approvalType}`} />
	</div> : null;

	return <div className="flex gap-2 mx-0.5 items-center">
		{approveButton}
		{cancelButton}
		{approvalToggle}
	</div>;
};

export const ToolChildrenWrapper = ({ children, className }: { children: React.ReactNode; className?: string }) => {
	return <div className={`${className ? className : ''} cursor-default select-none`}>
		<div className='px-2 min-w-full overflow-hidden'>
			{children}
		</div>
	</div>;
};
export const CodeChildren = ({ children, className }: { children: React.ReactNode; className?: string }) => {
	return <div className={`${className ?? ''} p-1 rounded-sm overflow-auto text-sm`}>
		<div className='!select-text cursor-auto'>
			{children}
		</div>
	</div>;
};

export const ListableToolItem = ({ name, onClick, isSmall, className, showDot }: { name: React.ReactNode; onClick?: () => void; isSmall?: boolean; className?: string; showDot?: boolean }) => {
	return <div
		className={`
			${onClick ? 'hover:brightness-125 hover:cursor-pointer transition-all duration-200 ' : ''}
			flex items-center flex-nowrap whitespace-nowrap
			${className ? className : ''}
			`}
		onClick={onClick}
	>
		{showDot === false ? null : <div className="flex-shrink-0"><svg className="w-1 h-1 opacity-60 mr-1.5 fill-current" viewBox="0 0 100 40"><rect x="0" y="15" width="100" height="10" /></svg></div>}
		<div className={`${isSmall ? 'italic text-vibe-fg-4 flex items-center' : ''}`}>{name}</div>
	</div>;
};



const EditToolChildren = ({ uri, code, type }: { uri: URI | undefined; code: string; type: 'diff' | 'rewrite' }) => {

	const content = type === 'diff' ?
		<VibeDiffEditor uri={uri} searchReplaceBlocks={code} />
		: <ChatMarkdownRender string={`\`\`\`\n${code}\n\`\`\``} codeURI={uri} chatMessageLocation={undefined} />;

	return <div className='!select-text cursor-auto'>
		<SmallProseWrapper>
			{content}
		</SmallProseWrapper>
	</div>;

};


const LintErrorChildren = ({ lintErrors }: { lintErrors: LintErrorItem[] }) => {
	return <div className="text-xs text-vibe-fg-4 opacity-80 border-l-2 border-vibe-warning px-2 py-0.5 flex flex-col gap-0.5 overflow-x-auto whitespace-nowrap">
		{lintErrors.map((error, i) => (
			<div key={i}>Lines {error.startLineNumber}-{error.endLineNumber}: {error.message}</div>
		))}
	</div>;
};

const BottomChildren = ({ children, title }: { children: React.ReactNode; title: string }) => {
	const [isOpen, setIsOpen] = useState(false);
	if (!children) {return null;}
	return (
		<div className="w-full px-2 mt-0.5">
			<div
				className={`flex items-center cursor-pointer select-none transition-colors duration-150 pl-0 py-0.5 rounded group`}
				onClick={() => setIsOpen(o => !o)}
				style={{ background: 'none' }}
			>
				<ChevronRight
					className={`mr-1 h-3 w-3 flex-shrink-0 transition-transform duration-100 text-vibe-fg-4 group-hover:text-vibe-fg-3 ${isOpen ? 'rotate-90' : ''}`}
				/>
				<span className="font-medium text-vibe-fg-4 group-hover:text-vibe-fg-3 text-xs">{title}</span>
			</div>
			<div
				className={`overflow-hidden transition-all duration-200 ease-in-out ${isOpen ? 'opacity-100' : 'max-h-0 opacity-0'} text-xs pl-4`}
			>
				<div className="overflow-x-auto text-vibe-fg-4 opacity-90 border-l-2 border-vibe-warning px-2 py-0.5">
					{children}
				</div>
			</div>
		</div>
	);
};


const EditToolHeaderButtons = ({ applyBoxId, uri, codeStr, toolName, threadId }: { threadId: string; applyBoxId: string; uri: URI; codeStr: string; toolName: 'edit_file' | 'rewrite_file' }) => {
	const { streamState } = useEditToolStreamState({ applyBoxId, uri });
	return <div className='flex items-center gap-1'>
		{/* <StatusIndicatorForApplyButton applyBoxId={applyBoxId} uri={uri} /> */}
		{/* <JumpToFileButton uri={uri} /> */}
		{streamState === 'idle-no-changes' && <CopyButton codeStr={codeStr} toolTipName='Copy' />}
		<EditToolAcceptRejectButtonsHTML type={toolName} codeStr={codeStr} applyBoxId={applyBoxId} uri={uri} threadId={threadId} />
	</div>;
};



const InvalidTool = ({ toolName, message, mcpServerName }: { toolName: ToolName; message: string; mcpServerName: string | undefined }) => {
	const accessor = useAccessor();
	const title = getTitle({ name: toolName, type: 'invalid_params', mcpServerName });
	const desc1 = 'Invalid parameters';
	const icon = null;
	const isError = true;
	const componentParams: ToolHeaderParams = { title, desc1, isError, icon };

	componentParams.children = <ToolChildrenWrapper>
		<CodeChildren className='bg-vibe-bg-3'>
			{message}
		</CodeChildren>
	</ToolChildrenWrapper>;
	return <ToolHeaderWrapper {...componentParams} />;
};

const CanceledTool = ({ toolName, mcpServerName }: { toolName: ToolName; mcpServerName: string | undefined }) => {
	const accessor = useAccessor();
	const title = getTitle({ name: toolName, type: 'rejected', mcpServerName });
	const desc1 = '';
	const icon = null;
	const isRejected = true;
	const componentParams: ToolHeaderParams = { title, desc1, icon, isRejected };
	return <ToolHeaderWrapper {...componentParams} />;
};


const CommandTool = ({ toolMessage, type, threadId }: { threadId: string } & ({
	toolMessage: Exclude<ToolMessage<'run_command'>, { type: 'invalid_params' }>;
	type: 'run_command';
} | {
	toolMessage: Exclude<ToolMessage<'run_persistent_command'>, { type: 'invalid_params' }>;
	type: | 'run_persistent_command';
})) => {
	const accessor = useAccessor();

	const commandService = accessor.get('ICommandService');
	const terminalToolsService = accessor.get('ITerminalToolService');
	const toolsService = accessor.get('IToolsService');
	const isError = false;
	const title = getTitle(toolMessage);
	const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
	const icon = null;
	const streamState = useChatThreadsStreamState(threadId);

	const divRef = useRef<HTMLDivElement | null>(null);

	const isRejected = toolMessage.type === 'rejected';
	const { rawParams, params } = toolMessage;
	const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, };


	const effect = async () => {
		if (streamState?.isRunning !== 'tool') {return;}
		if (type !== 'run_command' || toolMessage.type !== 'running_now') {return;}

		// wait for the interruptor so we know it's running

		await streamState?.interrupt;
		const container = divRef.current;
		if (!container) {return;}

		const terminal = terminalToolsService.getTemporaryTerminal(toolMessage.params.terminalId);
		if (!terminal) {return;}

		try {
			terminal.attachToElement(container);
			terminal.setVisible(true);
		} catch {
		}

		// Listen for size changes of the container and keep the terminal layout in sync.
		const resizeObserver = new ResizeObserver((entries) => {
			const height = entries[0].borderBoxSize[0].blockSize;
			const width = entries[0].borderBoxSize[0].inlineSize;
			if (typeof terminal.layout === 'function') {
				terminal.layout({ width, height });
			}
		});

		resizeObserver.observe(container);
		return () => { terminal.detachFromElement(); resizeObserver?.disconnect(); };
	};

	useEffect(() => {
		effect();
	}, [terminalToolsService, toolMessage, toolMessage.type, type]);

	if (toolMessage.type === 'success') {
		const { result } = toolMessage;

		// it's unclear that this is a button and not an icon.
		// componentParams.desc2 = <JumpToTerminalButton
		// 	onClick={() => { terminalToolsService.openTerminal(terminalId) }}
		// />

		let msg: string;
		if (type === 'run_command') {msg = toolsService.stringOfResult['run_command'](toolMessage.params, result);}
		else {msg = toolsService.stringOfResult['run_persistent_command'](toolMessage.params, result);}

		if (type === 'run_persistent_command') {
			componentParams.info = persistentTerminalNameOfId(toolMessage.params.persistentTerminalId);
		}

		componentParams.children = <ToolChildrenWrapper className='whitespace-pre text-nowrap overflow-auto text-sm'>
			<div className='!select-text cursor-auto'>
				<BlockCode initValue={`${msg.trim()}`} language='shellscript' />
			</div>
		</ToolChildrenWrapper>;
	}
	else if (toolMessage.type === 'tool_error') {
		const { result } = toolMessage;
		componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
			<CodeChildren>
				{result}
			</CodeChildren>
		</BottomChildren>;
	}
	else if (toolMessage.type === 'running_now') {
		if (type === 'run_command')
			{componentParams.children = <div ref={divRef} className='relative h-[300px] text-sm' />;}
	}
	else if (toolMessage.type === 'rejected' || toolMessage.type === 'tool_request') {
	}

	return <>
		<ToolHeaderWrapper {...componentParams} isOpen={type === 'run_command' && toolMessage.type === 'running_now' ? true : undefined} />
	</>;
};

type WrapperProps<T extends ToolName> = { toolMessage: Exclude<ToolMessage<T>, { type: 'invalid_params' }>; messageIdx: number; threadId: string };
const MCPToolWrapper = ({ toolMessage }: WrapperProps<string>) => {
	const accessor = useAccessor();
	const mcpService = accessor.get('IMCPService');

	const title = getTitle(toolMessage);
	const desc1 = removeMCPToolNamePrefix(toolMessage.name);
	const icon = null;


	if (toolMessage.type === 'running_now') {return null;} // do not show running

	const isError = false;
	const isRejected = toolMessage.type === 'rejected';
	const { rawParams, params } = toolMessage;

	// Redact sensitive values in params before display/copy
	const redactParams = (value: any): any => {
		const SENSITIVE_KEYS = new Set(['token', 'apiKey', 'apikey', 'password', 'authorization', 'auth', 'secret', 'clientSecret', 'accessToken', 'bearer']);
		const redactValue = (v: any) => (typeof v === 'string' ? (v.length > 6 ? v.slice(0, 3) + '***' + v.slice(-2) : '***') : v);
		if (Array.isArray(value)) {return value.map(redactParams);}
		if (value && typeof value === 'object') {
			const out: any = Array.isArray(value) ? [] : {};
			for (const k of Object.keys(value)) {
				if (SENSITIVE_KEYS.has(k.toLowerCase())) {out[k] = redactValue(value[k]);}
				else {out[k] = redactParams(value[k]);}
			}
			return out;
		}
		return value;
	};
	const componentParams: ToolHeaderParams = { title, desc1, isError, icon, isRejected, };

	const redactedParams = redactParams(params);
	const paramsStr = JSON.stringify(redactedParams, null, 2);
	componentParams.desc2 = <CopyButton codeStr={paramsStr} toolTipName={`Copy inputs (redacted): ${paramsStr}`} />;

	componentParams.info = !toolMessage.mcpServerName ? 'MCP tool not found' : undefined;

	// Add copy inputs button in desc2


	if (toolMessage.type === 'success' || toolMessage.type === 'tool_request') {
		const { result } = toolMessage;
		if (result) {
			const resultStr = mcpService.stringifyResult(result);
			// Check if result is text (not JSON) - text events return plain text, others return JSON
			// Type guard: check if result has 'event' property and it's 'text'
			const isTextResult = typeof result === 'object' && result !== null && (result as Readonly<Record<string, unknown>>).event === 'text';
			// If it's text, display as markdown; otherwise display as JSON code block
			const displayContent = isTextResult ? resultStr : `\`\`\`json\n${resultStr}\n\`\`\``;
			componentParams.children = <ToolChildrenWrapper>
				<SmallProseWrapper>
					<ChatMarkdownRender
						string={displayContent}
						chatMessageLocation={undefined}
						isApplyEnabled={false}
						isLinkDetectionEnabled={true}
					/>
				</SmallProseWrapper>
			</ToolChildrenWrapper>;
		}
	}
	else if (toolMessage.type === 'tool_error') {
		const { result } = toolMessage;
		componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
			<CodeChildren>
				{result}
			</CodeChildren>
		</BottomChildren>;
	}

	return <ToolHeaderWrapper {...componentParams} />;

};

type ResultWrapper<T extends ToolName> = (props: WrapperProps<T>) => React.ReactNode;

const builtinToolNameToComponent: { [T in BuiltinToolName]: { resultWrapper: ResultWrapper<T> } } = {
	'read_file': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const commandService = accessor.get('ICommandService');

			const title = getTitle(toolMessage);

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null;

			if (toolMessage.type === 'tool_request') {return null;} // do not show past requests
			if (toolMessage.type === 'running_now') {return null;} // do not show running

			const isError = false;
			const isRejected = toolMessage.type === 'rejected';
			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, };

			let range: [number, number] | undefined = undefined;
			if (toolMessage.params.startLine !== null || toolMessage.params.endLine !== null) {
				const start = toolMessage.params.startLine === null ? `1` : `${toolMessage.params.startLine}`;
				const end = toolMessage.params.endLine === null ? `` : `${toolMessage.params.endLine}`;
				const addStr = `(${start}-${end})`;
				componentParams.desc1 += ` ${addStr}`;
				range = [params.startLine || 1, params.endLine || 1];
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage;
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor, range); };
				if (result.hasNextPage && params.pageNumber === 1 && range === undefined)  // first page of a full-file read (not a line-range slice)
					// Honest partial-read label: truncation can now happen well before the 500k page cap
					// (line limit or the large-file char budget), so report the actual window instead.
					{componentParams.desc2 = result.endLineReturned && result.totalNumLines
						? `(partial: lines 1-${result.endLineReturned} of ${result.totalNumLines})`
						: `(partial read)`;}
				else if (params.pageNumber > 1) // subsequent pages
					{componentParams.desc2 = `(part ${params.pageNumber})`;}
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				// JumpToFileButton removed in favor of FileLinkText
				componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>;
			}

			return <ToolHeaderWrapper {...componentParams} />;
		},
	},
	'get_dir_tree': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const commandService = accessor.get('ICommandService');

			const title = getTitle(toolMessage);
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null;

			if (toolMessage.type === 'tool_request') {return null;} // do not show past requests
			if (toolMessage.type === 'running_now') {return null;} // do not show running

			const isError = false;
			const isRejected = toolMessage.type === 'rejected';
			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, };

			if (params.uri) {
				const rel = getRelative(params.uri, accessor);
				if (rel) {componentParams.info = `Only search in ${rel}`;}
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage;
				componentParams.children = <ToolChildrenWrapper>
					<SmallProseWrapper>
						<ChatMarkdownRender
							string={`\`\`\`\n${result.str}\n\`\`\``}
							chatMessageLocation={undefined}
							isApplyEnabled={false}
							isLinkDetectionEnabled={true}
						/>
					</SmallProseWrapper>
				</ToolChildrenWrapper>;
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>;
			}

			return <ToolHeaderWrapper {...componentParams} />;

		}
	},
	'ls_dir': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const commandService = accessor.get('ICommandService');
			const explorerService = accessor.get('IExplorerService');
			const title = getTitle(toolMessage);
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null;

			if (toolMessage.type === 'tool_request') {return null;} // do not show past requests
			if (toolMessage.type === 'running_now') {return null;} // do not show running

			const isError = false;
			const isRejected = toolMessage.type === 'rejected';
			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, };

			if (params.uri) {
				const rel = getRelative(params.uri, accessor);
				if (rel) {componentParams.info = `Only search in ${rel}`;}
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage;
				componentParams.numResults = result.children?.length;
				componentParams.hasNextPage = result.hasNextPage;
				componentParams.children = !result.children || (result.children.length ?? 0) === 0 ? undefined
					: <ToolChildrenWrapper>
						{result.children.map((child, i) => (<ListableToolItem key={i}
							name={`${child.name}${child.isDirectory ? '/' : ''}`}
							className='w-full overflow-auto'
							onClick={() => {
								voidOpenFileFn(child.uri, accessor);
								// commandService.executeCommand('workbench.view.explorer'); // open in explorer folders view instead
								// explorerService.select(child.uri, true);
							}}
						/>))}
						{result.hasNextPage &&
							<ListableToolItem name={`Results truncated (${result.itemsRemaining} remaining).`} isSmall={true} className='w-full overflow-auto' />
						}
					</ToolChildrenWrapper>;
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>;
			}

			return <ToolHeaderWrapper {...componentParams} />;
		}
	},
	'search_pathnames_only': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const commandService = accessor.get('ICommandService');
			const isError = false;
			const isRejected = toolMessage.type === 'rejected';
			const title = getTitle(toolMessage);
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null;

			if (toolMessage.type === 'tool_request') {return null;} // do not show past requests
			if (toolMessage.type === 'running_now') {return null;} // do not show running

			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, };

			if (params.includePattern) {
				componentParams.info = `Only search in ${params.includePattern}`;
			}

			if (toolMessage.type === 'success') {
				const { result, rawParams } = toolMessage;
				componentParams.numResults = result.uris.length;
				componentParams.hasNextPage = result.hasNextPage;
				componentParams.children = result.uris.length === 0 ? undefined
					: <ToolChildrenWrapper>
						{result.uris.map((uri, i) => (<ListableToolItem key={i}
							name={getBasename(uri.fsPath)}
							className='w-full overflow-auto'
							onClick={() => { voidOpenFileFn(uri, accessor); }}
						/>))}
						{result.hasNextPage &&
							<ListableToolItem name={'Results truncated.'} isSmall={true} className='w-full overflow-auto' />
						}

					</ToolChildrenWrapper>;
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>;
			}

			return <ToolHeaderWrapper {...componentParams} />;
		}
	},
	'search_for_files': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const commandService = accessor.get('ICommandService');
			const isError = false;
			const isRejected = toolMessage.type === 'rejected';
			const title = getTitle(toolMessage);
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null;

			if (toolMessage.type === 'tool_request') {return null;} // do not show past requests
			if (toolMessage.type === 'running_now') {return null;} // do not show running

			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, };

			if (params.searchInFolder || params.isRegex) {
				const info: string[] = [];
				if (params.searchInFolder) {
					const rel = getRelative(params.searchInFolder, accessor);
					if (rel) {info.push(`Only search in ${rel}`);}
				}
				if (params.isRegex) { info.push(`Uses regex search`); }
				componentParams.info = info.join('; ');
			}

			if (toolMessage.type === 'success') {
				const { result, rawParams } = toolMessage;
				componentParams.numResults = result.uris.length;
				componentParams.hasNextPage = result.hasNextPage;
				componentParams.children = result.uris.length === 0 ? undefined
					: <ToolChildrenWrapper>
						{result.uris.map((uri, i) => (<ListableToolItem key={i}
							name={getBasename(uri.fsPath)}
							className='w-full overflow-auto'
							onClick={() => { voidOpenFileFn(uri, accessor); }}
						/>))}
						{result.hasNextPage &&
							<ListableToolItem name={`Results truncated.`} isSmall={true} className='w-full overflow-auto' />
						}

					</ToolChildrenWrapper>;
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>;
			}
			return <ToolHeaderWrapper {...componentParams} />;
		}
	},

	'search_in_file': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const toolsService = accessor.get('IToolsService');
			const title = getTitle(toolMessage);
			const isError = false;
			const isRejected = toolMessage.type === 'rejected';
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null;

			if (toolMessage.type === 'tool_request') {return null;} // do not show past requests
			if (toolMessage.type === 'running_now') {return null;} // do not show running

			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected };

			const infoarr: string[] = [];
			const uriStr = getRelative(params.uri, accessor);
			if (uriStr) {infoarr.push(uriStr);}
			if (params.isRegex) {infoarr.push('Uses regex search');}
			componentParams.info = infoarr.join('; ');

			if (toolMessage.type === 'success') {
				const { result } = toolMessage; // result is array of snippets
				componentParams.numResults = result.lines.length;
				componentParams.children = result.lines.length === 0 ? undefined :
					<ToolChildrenWrapper>
						<CodeChildren className='bg-vibe-bg-3'>
							<pre className='font-mono whitespace-pre'>
								{toolsService.stringOfResult['search_in_file'](params, result)}
							</pre>
						</CodeChildren>
					</ToolChildrenWrapper>;
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>;
			}

			return <ToolHeaderWrapper {...componentParams} />;
		}
	},

	'read_lint_errors': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const commandService = accessor.get('ICommandService');

			const title = getTitle(toolMessage);

			const { uri } = toolMessage.params ?? {};
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null;

			if (toolMessage.type === 'tool_request') {return null;} // do not show past requests
			if (toolMessage.type === 'running_now') {return null;} // do not show running

			const isError = false;
			const isRejected = toolMessage.type === 'rejected';
			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, };

			componentParams.info = getRelative(uri, accessor); // full path

			if (toolMessage.type === 'success') {
				const { result } = toolMessage;
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor); };
				if (result.lintErrors)
					{componentParams.children = <LintErrorChildren lintErrors={result.lintErrors} />;}
				else
					{componentParams.children = `No lint errors found.`;}

			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				// JumpToFileButton removed in favor of FileLinkText
				componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>;
			}

			return <ToolHeaderWrapper {...componentParams} />;
		},
	},

	// ---

	'create_file_or_folder': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const commandService = accessor.get('ICommandService');
			const isError = false;
			const isRejected = toolMessage.type === 'rejected';
			const title = getTitle(toolMessage);
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null;


			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, };

			componentParams.info = getRelative(params.uri, accessor); // full path

			if (toolMessage.type === 'success') {
				const { result } = toolMessage;
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor); };
			}
			else if (toolMessage.type === 'rejected') {
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor); };
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				if (params) { componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor); }; }
				componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>;
			}
			else if (toolMessage.type === 'running_now') {
				// nothing more is needed
			}
			else if (toolMessage.type === 'tool_request') {
				// nothing more is needed
			}

			return <ToolHeaderWrapper {...componentParams} />;
		}
	},
	'delete_file_or_folder': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const commandService = accessor.get('ICommandService');
			const isFolder = toolMessage.params?.isFolder ?? false;
			const isError = false;
			const isRejected = toolMessage.type === 'rejected';
			const title = getTitle(toolMessage);
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null;

			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, };

			componentParams.info = getRelative(params.uri, accessor); // full path

			if (toolMessage.type === 'success') {
				const { result } = toolMessage;
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor); };
			}
			else if (toolMessage.type === 'rejected') {
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor); };
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				if (params) { componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor); }; }
				componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>;
			}
			else if (toolMessage.type === 'running_now') {
				const { result } = toolMessage;
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor); };
			}
			else if (toolMessage.type === 'tool_request') {
				const { result } = toolMessage;
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor); };
			}

			return <ToolHeaderWrapper {...componentParams} />;
		}
	},
	'rewrite_file': {
		resultWrapper: (params) => {
			return <EditTool {...params} content={params.toolMessage.params.newContent} />;
		}
	},
	'edit_file': {
		resultWrapper: (params) => {
			return <EditTool {...params} content={params.toolMessage.params.searchReplaceBlocks} />;
		}
	},

	// ---

	'run_command': {
		resultWrapper: (params) => {
			return <CommandTool {...params} type='run_command' />;
		}
	},

	'run_persistent_command': {
		resultWrapper: (params) => {
			return <CommandTool {...params} type='run_persistent_command' />;
		}
	},
	'open_persistent_terminal': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const terminalToolsService = accessor.get('ITerminalToolService');

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const title = getTitle(toolMessage);
			const icon = null;

			if (toolMessage.type === 'tool_request') {return null;} // do not show past requests
			if (toolMessage.type === 'running_now') {return null;} // do not show running

			const isError = false;
			const isRejected = toolMessage.type === 'rejected';
			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, };

			const relativePath = params.cwd ? getRelative(URI.file(params.cwd), accessor) : '';
			componentParams.info = relativePath ? `Running in ${relativePath}` : undefined;

			if (toolMessage.type === 'success') {
				const { result } = toolMessage;
				const { persistentTerminalId } = result;
				componentParams.desc1 = persistentTerminalNameOfId(persistentTerminalId);
				componentParams.onClick = () => terminalToolsService.focusPersistentTerminal(persistentTerminalId);
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>;
			}

			return <ToolHeaderWrapper {...componentParams} />;
		},
	},
	'kill_persistent_terminal': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const commandService = accessor.get('ICommandService');
			const terminalToolsService = accessor.get('ITerminalToolService');

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const title = getTitle(toolMessage);
			const icon = null;

			if (toolMessage.type === 'tool_request') {return null;} // do not show past requests
			if (toolMessage.type === 'running_now') {return null;} // do not show running

			const isError = false;
			const isRejected = toolMessage.type === 'rejected';
			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, };

			if (toolMessage.type === 'success') {
				const { persistentTerminalId } = params;
				componentParams.desc1 = persistentTerminalNameOfId(persistentTerminalId);
				componentParams.onClick = () => terminalToolsService.focusPersistentTerminal(persistentTerminalId);
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>;
			}

			return <ToolHeaderWrapper {...componentParams} />;
		},
	},
	'web_search': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const toolsService = accessor.get('IToolsService');
			const title = getTitle(toolMessage);
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null;

			if (toolMessage.type === 'tool_request') {return null;} // do not show past requests
			if (toolMessage.type === 'running_now') {
				// Show loading indicator
				const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError: false, icon, isRejected: false };
				componentParams.children = <ToolChildrenWrapper>
					<div className='flex items-center gap-2 text-sm text-vibe-fg-3'>
						<IconLoading state="processing" inline />
						<span>Searching the web...</span>
					</div>
				</ToolChildrenWrapper>;
				return <ToolHeaderWrapper {...componentParams} />;
			}

			const isError = false;
			const isRejected = toolMessage.type === 'rejected';
			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, };

			if (toolMessage.type === 'success') {
				const { result } = toolMessage;
				componentParams.numResults = result.results?.length || 0;

				if (result.results && result.results.length > 0) {
					componentParams.children = <ToolChildrenWrapper>
						<div className='space-y-3'>
							{result.results.map((r: { title: string; snippet: string; url: string }, i: number) => (
								<div key={i} className='border border-vibe-border-2 bg-vibe-bg-2 rounded p-3 hover:bg-vibe-bg-3 transition-colors'>
									<a
										href={r.url}
										target='_blank'
										rel='noopener noreferrer'
										className='block group'
									>
										<div className='text-sm font-semibold text-blue-400 group-hover:text-blue-300 mb-1 line-clamp-2'>
											{r.title}
										</div>
										<div className='text-xs text-vibe-fg-4 mb-2 truncate'>
											{r.url}
										</div>
										<div className='text-sm text-vibe-fg-2 line-clamp-3'>
											{r.snippet}
										</div>
									</a>
								</div>
							))}
						</div>
					</ToolChildrenWrapper>;
				} else {
					componentParams.children = <ToolChildrenWrapper>
						<div className='text-sm text-vibe-fg-3'>
							No search results found.
						</div>
					</ToolChildrenWrapper>;
				}
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>;
			}

			return <ToolHeaderWrapper {...componentParams} />;
		},
	},
	'browse_url': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const toolsService = accessor.get('IToolsService');
			const title = getTitle(toolMessage);
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null;

			if (toolMessage.type === 'tool_request') {return null;} // do not show past requests
			if (toolMessage.type === 'running_now') {
				// Show loading indicator
				const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError: false, icon, isRejected: false };
				componentParams.children = <ToolChildrenWrapper>
					<div className='flex items-center gap-2 text-sm text-vibe-fg-3'>
						<IconLoading state="processing" inline />
						<span>Fetching content from URL...</span>
					</div>
				</ToolChildrenWrapper>;
				return <ToolHeaderWrapper {...componentParams} />;
			}

			const isError = false;
			const isRejected = toolMessage.type === 'rejected';
			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, };

			if (toolMessage.type === 'success') {
				const { result } = toolMessage;
				const urlStr = result.url || params.url;

				componentParams.onClick = () => {
					if (urlStr) {
						window.open(urlStr, '_blank', 'noopener,noreferrer');
					}
				};
				componentParams.info = urlStr ? `Source: ${new URL(urlStr).hostname}` : undefined;

				if (result.content) {
					const contentPreview = result.content.length > 2000
						? result.content.substring(0, 2000) + '\n\n... (content truncated)'
						: result.content;

					componentParams.children = <ToolChildrenWrapper>
						<div className='space-y-3'>
							{result.title && (
								<div className='text-lg font-semibold text-vibe-fg-1'>
									{result.title}
								</div>
							)}
							{result.metadata?.publishedDate && (
								<div className='text-xs text-vibe-fg-4'>
									Published: {result.metadata.publishedDate}
								</div>
							)}
							{urlStr && (
								<a
									href={urlStr}
									target='_blank'
									rel='noopener noreferrer'
									className='text-sm text-blue-400 hover:text-blue-300 block truncate'
								>
									{urlStr}
								</a>
							)}
							<div className='text-sm text-vibe-fg-2 whitespace-pre-wrap max-h-96 overflow-y-auto border border-vibe-border-2 bg-vibe-bg-3 rounded p-3'>
								{contentPreview}
							</div>
						</div>
					</ToolChildrenWrapper>;
				} else {
					componentParams.children = <ToolChildrenWrapper>
						<div className='text-sm text-vibe-fg-3'>
							No content extracted from URL.
						</div>
					</ToolChildrenWrapper>;
				}
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				componentParams.bottomChildren = <BottomChildren title={chatS.bottomChildrenError}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>;
			}

			return <ToolHeaderWrapper {...componentParams} />;
		},
	},
};


const Checkpoint = ({ message, threadId, messageIdx, isCheckpointGhost, threadIsRunning }: { message: CheckpointEntry; threadId: string; messageIdx: number; isCheckpointGhost: boolean; threadIsRunning: boolean }) => {
	const accessor = useAccessor();
	const chatThreadService = accessor.get('IChatThreadService');
	const streamState = useFullChatThreadsStreamState();

	// Subscribe to thread state changes properly
	const chatThreadsState = useChatThreadsState();

	const isRunning = useChatThreadsStreamState(threadId)?.isRunning;
	const isDisabled = useMemo(() => {
		if (isRunning) {return true;}
		// Use Object.values().some() instead of Object.keys().find() for better performance
		return Object.values(streamState).some(threadState => threadState?.isRunning);
	}, [isRunning, streamState]);

	// Memoize message count lookup to avoid direct state access in render
	const threadMessagesLength = chatThreadsState.allThreads[threadId]?.messages.length ?? 0;

	return <div
		className={`flex items-center justify-center px-2 `}
	>
		<div
			className={`
                    text-xs
                    text-vibe-fg-3
                    select-none
                    ${isCheckpointGhost ? 'opacity-50' : 'opacity-100'}
					${isDisabled ? 'cursor-default' : 'cursor-pointer'}
                `}
			style={{ position: 'relative', display: 'inline-block' }} // allow absolute icon
			onClick={() => {
				if (threadIsRunning) {return;}
				if (isDisabled) {return;}
				void chatThreadService.jumpToCheckpointBeforeMessageIdx({
					threadId,
					messageIdx,
					jumpToUserModified: messageIdx === threadMessagesLength - 1
				});
			}}
			{...isDisabled ? {
				'data-tooltip-id': 'vibe-tooltip',
				'data-tooltip-content': `Disabled ${isRunning ? 'when running' : 'because another thread is running'}`,
				'data-tooltip-place': 'top',
			} : {}}
		>
			Checkpoint<ChatTimestamp ts={message.createdAt} align='inline' />
		</div>
	</div>;
};


type ChatBubbleMode = 'display' | 'edit';
type ChatBubbleProps = {
	chatMessage: ChatMessage;
	messageIdx: number;
	isCommitted: boolean;
	chatIsRunning: IsRunningType;
	threadId: string;
	currCheckpointIdx: number | undefined;
	_scrollToBottom: (() => void) | null;
};

// Plan Component - Shows structured execution plan as a todo list
// Plan Component - Shows structured execution plan as a todo list
const PlanComponent = React.memo(({ message, isCheckpointGhost, threadId, messageIdx }: { message: PlanMessage; isCheckpointGhost: boolean; threadId: string; messageIdx: number }) => {
	const accessor = useAccessor();
	const chatThreadService = accessor.get('IChatThreadService');
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
	const [isCollapsed, setIsCollapsed] = useState(false);

	// Subscribe to thread state changes properly
	const chatThreadsState = useChatThreadsState();
	const settingsState = useSettingsState();
    const approvalState = message.approvalState || 'pending';
    const isRunning = useChatThreadsStreamState(threadId)?.isRunning;
    const isBusy = isRunning === 'LLM' || isRunning === 'tool' || isRunning === 'preparing';
    const isIdleLike = isRunning === undefined || isRunning === 'idle';
	// True when the chat was in Plan mode when this plan was created
	const isPlanMode = settingsState.globalSettings.chatMode === 'plan';

	// Get thread messages with proper subscription
	const thread = chatThreadsState.allThreads[threadId];
	const threadMessages = thread?.messages ?? [];

	// Memoize tool message lookup map for O(1) access instead of O(n) searches
	const toolMessagesMap = useMemo(() => {
		const map = new Map<string, ToolMessage<any>>();
		for (const msg of threadMessages) {
			if (msg.role === 'tool') {
				const toolMsg = msg as ToolMessage<any>;
				map.set(toolMsg.id, toolMsg);
			}
		}
		return map;
	}, [threadMessages]);

	// Calculate progress - memoize to avoid recalculating on every render
	const totalSteps = message.steps.length;
	const completedSteps = useMemo(() =>
		message.steps.filter(s => s.status === 'succeeded' || s.status === 'skipped').length
	, [message.steps]);
	const progressText = useMemo(() =>
		`${completedSteps} of ${totalSteps} ${totalSteps === 1 ? 'Step' : 'Steps'} Completed`
	, [completedSteps, totalSteps]);

	// Memoize hasPausedSteps to avoid recalculating on every render
	const hasPausedSteps = useMemo(() =>
		message.steps.some(s => s.status === 'paused')
	, [message.steps]);

	const getCheckmarkIcon = (status?: StepStatus, isDisabled?: boolean) => {
		if (isDisabled) {
			return <div className="w-5 h-5 rounded-full border-2 border-vibe-fg-4 flex items-center justify-center opacity-40" />;
		}

		switch (status) {
			case 'succeeded':
				return (
					<div className="w-5 h-5 rounded-full border-2 border-green-500 bg-green-500/20 flex items-center justify-center">
						<Check size={12} className="text-green-400" strokeWidth={3} />
					</div>
				);
			case 'failed':
				return (
					<div className="w-5 h-5 rounded-full border-2 border-red-500 bg-red-500/20 flex items-center justify-center">
						<X size={12} className="text-red-400" strokeWidth={3} />
					</div>
				);
			case 'running':
				return (
					<div className="w-5 h-5 rounded-full border-2 border-yellow-500 bg-yellow-500/20 flex items-center justify-center">
						<CircleEllipsis size={12} className="text-yellow-400 animate-spin" />
					</div>
				);
			case 'paused':
				return (
					<div className="w-5 h-5 rounded-full border-2 border-orange-500 bg-orange-500/20 flex items-center justify-center">
						<Dot size={12} className="text-orange-400" />
					</div>
				);
			case 'skipped':
				return (
					<div className="w-5 h-5 rounded-full border-2 border-gray-500 bg-gray-500/20 flex items-center justify-center opacity-60">
						<Ban size={12} className="text-gray-400" />
					</div>
				);
			default: // queued
				return (
					<div className="w-5 h-5 rounded-full border-2 border-vibe-fg-3 flex items-center justify-center">
						<div className="w-1.5 h-1.5 rounded-full bg-vibe-fg-3 opacity-60" />
					</div>
				);
		}
	};

	const toggleStepExpanded = (stepNumber: number) => {
		setExpandedSteps(prev => {
			const next = new Set(prev);
			if (next.has(stepNumber)) {
				next.delete(stepNumber);
			} else {
				next.add(stepNumber);
			}
			return next;
		});
	};

    const handleApprove = () => {
        if (isCheckpointGhost || isBusy) {return;}
		chatThreadService.approvePlan({ threadId, messageIdx });
	};

	const handleReject = () => {
        if (isCheckpointGhost || isBusy) {return;}
		chatThreadService.rejectPlan({ threadId, messageIdx });
	};

	const handleToggleStep = (stepNumber: number) => {
        if (isCheckpointGhost || isBusy) {return;}
		chatThreadService.toggleStepDisabled({ threadId, messageIdx, stepNumber });
	};

	// Switch to Agent mode first, then approve — "Execute in Agent" for Plan Mode
	const handleExecuteInAgent = () => {
		if (isCheckpointGhost || isBusy) {return;}
		vibeideSettingsService.setGlobalSetting('chatMode', 'agent');
		chatThreadService.approvePlan({ threadId, messageIdx });
	};

	const getStatusBadge = (status?: StepStatus) => {
		switch (status) {
			case 'running':
				return <span className="px-1.5 py-0.5 text-xs rounded bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">Running</span>;
			case 'failed':
				return <span className="px-1.5 py-0.5 text-xs rounded bg-red-500/20 text-red-400 border border-red-500/30">Failed</span>;
			case 'paused':
				return <span className="px-1.5 py-0.5 text-xs rounded bg-orange-500/20 text-orange-400 border border-orange-500/30">Paused</span>;
			case 'skipped':
				return <span className="px-1.5 py-0.5 text-xs rounded bg-gray-500/20 text-gray-400 border border-gray-500/30">Skipped</span>;
			default:
				return null;
		}
	};

	return (
		<div
			className={`${isCheckpointGhost ? 'opacity-50 pointer-events-none' : ''} my-3`}
			role="region"
			aria-label={`Agent plan: ${message.summary || 'Untitled plan'}`}
		>
			<div className="bg-vibe-bg-1 border border-vibe-border-1 rounded-lg overflow-hidden">
				{/* Header */}
				<div className="px-4 py-3 border-b border-vibe-border-1 bg-vibe-bg-2/30">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2 flex-1 min-w-0">
							<button
								type="button"
								onClick={() => setIsCollapsed(!isCollapsed)}
								className="flex-shrink-0 p-1 hover:bg-vibe-bg-2 rounded transition-colors"
								disabled={isCheckpointGhost}
								aria-expanded={!isCollapsed}
								aria-controls="vibe-plan-steps-list"
								aria-label={isCollapsed ? 'Expand plan steps' : 'Collapse plan steps'}
							>
								<ChevronRight
									size={16}
									className={`text-vibe-fg-3 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
								/>
							</button>
							<div className="flex items-center gap-2 flex-1 min-w-0">
								<h3 className="text-vibe-fg-1 font-medium text-sm truncate">{message.summary}</h3>
								{approvalState === 'pending' && (
									<span className="px-2 py-0.5 text-xs rounded bg-blue-500/20 text-blue-400 border border-blue-500/30 flex-shrink-0">
										Pending Approval
									</span>
								)}
								{approvalState === 'executing' && (
									<span className="px-2 py-0.5 text-xs rounded bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 flex items-center gap-1 flex-shrink-0">
										<CircleEllipsis size={12} className="animate-spin" />
										Executing
									</span>
								)}
								{approvalState === 'completed' && (
									<span className="px-2 py-0.5 text-xs rounded bg-green-500/20 text-green-400 border border-green-500/30 flex items-center gap-1 flex-shrink-0">
										<Check size={12} />
										Completed
									</span>
								)}
							</div>
						</div>

						{!isCollapsed && (
							<div className="flex items-center gap-3 flex-shrink-0">
								<span className="text-vibe-fg-3 text-xs" aria-live="polite">{progressText}</span>
								{approvalState === 'pending' && isIdleLike && (
									<div className="flex gap-2">
										<button
											type="button"
											title={chatS.planRejectTitle}
											aria-label={chatS.planRejectAria}
											onClick={handleReject}
											className="px-3 py-1.5 text-xs rounded bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/40"
										>
											{chatS.planRejectLabel}
										</button>
										{isPlanMode ? (
											<button
												type="button"
												title={chatS.planExecuteInAgentTitle}
												aria-label={chatS.planExecuteInAgentAria}
												onClick={handleExecuteInAgent}
												className="px-3 py-1.5 text-xs rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/40 flex items-center gap-1"
											>
												<ChevronRight size={12} />
												{chatS.planExecuteInAgentLabel}
											</button>
										) : (
											<button
												type="button"
												title={chatS.planApproveTitle}
												aria-label={chatS.planApproveAria}
												onClick={handleApprove}
												className="px-3 py-1.5 text-xs rounded bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 transition-colors focus:outline-none focus:ring-2 focus:ring-green-500/40"
											>
												{chatS.planApproveLabel}
											</button>
										)}
									</div>
								)}
							{approvalState === 'executing' && isBusy && (
								<button
									type="button"
									aria-label={chatS.planPauseAria}
										onClick={() => chatThreadService.pauseAgentExecution({ threadId })}
										className="px-3 py-1.5 text-xs rounded bg-orange-500/10 text-orange-400 border border-orange-500/20 hover:bg-orange-500/20 transition-colors focus:outline-none focus:ring-2 focus:ring-orange-500/40"
									>
										{chatS.planPauseLabel}
									</button>
								)}
							{hasPausedSteps && !isBusy && (
								<button
									type="button"
									aria-label={chatS.planResumeAria}
										onClick={() => chatThreadService.resumeAgentExecution({ threadId })}
										className="px-3 py-1.5 text-xs rounded bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 transition-colors focus:outline-none focus:ring-2 focus:ring-green-500/40"
									>
										{chatS.planResumeLabel}
									</button>
								)}
							</div>
						)}
					</div>
					{message.secondOpinion && message.secondOpinion.verdict !== 'looks_ok' && (
						<div className="mt-2 text-xs text-orange-300 border border-orange-500/40 rounded px-2 py-1.5 bg-orange-500/10" role="status">
							<span className="font-medium text-orange-200">{chatS.planAdvisoryReview}</span>
							{message.secondOpinion.message}
						</div>
					)}
				</div>

				{/* Todo List */}
				{!isCollapsed && (
					<ul id="vibe-plan-steps-list" className="list-none m-0 p-0 py-2" role="list">
						{message.steps.map((step) => {
							const isExpanded = expandedSteps.has(step.stepNumber);
							const isDisabled = step.disabled;
							const status = step.status || 'queued';
							const hasDetails = step.tools || step.files || step.error || step.toolCalls;
							const stepAria = chatS.planStepAria(step.stepNumber, status, (step.description || '').slice(0, 400));

							return (
								<li
									key={step.stepNumber}
									role="listitem"
									aria-label={stepAria}
									className={`flex items-start gap-3 px-4 py-2.5 hover:bg-vibe-bg-2/30 transition-colors ${
										isDisabled ? 'opacity-50' : ''
									} ${status === 'failed' ? 'bg-red-500/5' : ''}`}
								>
									{/* Checkmark */}
									<div className="flex-shrink-0 mt-0.5" aria-hidden="true">
										{getCheckmarkIcon(status, isDisabled)}
									</div>

									{/* Content */}
									<div className="flex-1 min-w-0">
										<div className="flex items-start justify-between gap-3">
											<p className={`text-vibe-fg-1 text-sm flex-1 leading-relaxed ${
												isDisabled ? 'line-through text-vibe-fg-3' : ''
											} ${status === 'succeeded' ? 'text-vibe-fg-2' : ''}`}>
												{step.description}
											</p>

											{/* Status Badge */}
											{getStatusBadge(status)}
										</div>

										{/* Actions Row */}
										{(approvalState === 'pending' || (approvalState === 'executing' && status === 'failed')) && !isCheckpointGhost && (
											<div className="flex items-center gap-2 mt-2">
												{approvalState === 'pending' && !isRunning && (
										<button
											type="button"
											aria-label={`${isDisabled ? 'Enable' : 'Disable'} step ${step.stepNumber}`}
														onClick={() => handleToggleStep(step.stepNumber)}
														className="px-2 py-0.5 text-xs rounded bg-vibe-bg-2 text-vibe-fg-2 hover:bg-vibe-bg-2/80 border border-vibe-border-1 transition-colors"
													>
														{isDisabled ? 'Enable' : 'Disable'}
													</button>
												)}
									{approvalState === 'executing' && status === 'failed' && (
													<>
											<button
												type="button"
												aria-label={`Retry step ${step.stepNumber}`}
															onClick={() => chatThreadService.retryStep({ threadId, messageIdx, stepNumber: step.stepNumber })}
															className="px-2 py-0.5 text-xs rounded bg-green-500/10 text-green-400 hover:bg-green-500/20 border border-green-500/20 transition-colors"
														>
															Retry
														</button>
											<button
												type="button"
												aria-label={`Skip step ${step.stepNumber}`}
															onClick={() => chatThreadService.skipStep({ threadId, messageIdx, stepNumber: step.stepNumber })}
															className="px-2 py-0.5 text-xs rounded bg-gray-500/10 text-gray-400 hover:bg-gray-500/20 border border-gray-500/20 transition-colors"
														>
															Skip
														</button>
														{step.checkpointIdx !== undefined && step.checkpointIdx !== null && (
								<button
									type="button"
									aria-label={`Rollback step ${step.stepNumber}`}
									onClick={() => { if (confirm('Rollback to the checkpoint before this step?')) {chatThreadService.rollbackToStep({ threadId, messageIdx, stepNumber: step.stepNumber });} }}
																className="px-2 py-0.5 text-xs rounded bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 border border-orange-500/20 transition-colors"
															>
																Rollback
															</button>
														)}
													</>
												)}
											</div>
										)}

										{/* Expandable Details */}
										{hasDetails && (
											<button
												type="button"
												aria-expanded={isExpanded}
												aria-label={`${isExpanded ? 'Hide' : 'Show'} details for step ${step.stepNumber}`}
												onClick={() => toggleStepExpanded(step.stepNumber)}
												className="mt-2 flex items-center gap-1 text-vibe-fg-3 hover:text-vibe-fg-2 text-xs transition-colors"
											>
												<ChevronRight
													size={12}
													className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}
												/>
												<span>{isExpanded ? 'Hide' : 'Show'} details</span>
											</button>
										)}

										{/* Expanded Content */}
										{isExpanded && hasDetails && (
											<div className="mt-3 space-y-3 pt-3 border-t border-vibe-border-1">
												{step.tools && step.tools.length > 0 && (
													<div>
														<div className="text-vibe-fg-3 text-xs mb-2 font-medium">Expected Tools:</div>
														<div className="flex flex-wrap gap-1.5">
															{step.tools.map((tool, i) => (
																<span key={`${step.stepNumber}-tool-${tool}-${i}`} className="px-2 py-0.5 bg-blue-500/10 text-blue-400 text-xs rounded border border-blue-500/20">
																	{tool}
																</span>
															))}
														</div>
													</div>
												)}
												{step.toolCalls && step.toolCalls.length > 0 && (
													<div>
											<div className="text-vibe-fg-3 text-xs mb-2 font-medium flex items-center gap-2">Tool Calls Executed <span className="inline-flex items-center justify-center rounded-full bg-vibe-bg-2 text-vibe-fg-3 text-[10px] px-1.5 py-0.5 border border-vibe-border-1">{step.toolCalls.length}</span></div>
														<div className="space-y-1.5">
															{step.toolCalls.map((toolId, i) => {
																// Use memoized map for O(1) lookup instead of O(n) find
																const toolMsg = toolMessagesMap.get(toolId);
																if (!toolMsg) {return null;}

																const isSuccess = toolMsg.type === 'success';
																const isError = toolMsg.type === 'tool_error';

																return (
																	<div key={toolId} className={`p-2 rounded border text-xs ${
																		isSuccess ? 'bg-green-500/10 border-green-500/20' :
																		isError ? 'bg-red-500/10 border-red-500/20' :
																		'bg-blue-500/10 border-blue-500/20'
																	}`}>
																		<div className="flex items-center justify-between mb-1">
																			<span className="font-medium text-vibe-fg-1">{toolMsg.name}</span>
																			{isSuccess && <Check size={12} className="text-green-400" />}
																			{isError && <X size={12} className="text-red-400" />}
																		</div>
																		{isError && toolMsg.result && (
																			<div className="mt-1 text-red-400 text-xs">
																				{toolMsg.result}
																			</div>
																		)}
																		{isSuccess && toolMsg.result && (
																			<details className="mt-1">
																				<summary className="text-vibe-fg-3 cursor-pointer text-xs hover:text-vibe-fg-2">View result</summary>
																				<pre className="mt-1 p-2 bg-vibe-bg-2 rounded text-xs overflow-auto max-h-32 border border-vibe-border-1">
																					{typeof toolMsg.result === 'string'
																						? toolMsg.result
																						: JSON.stringify(toolMsg.result, null, 2)}
																				</pre>
																			</details>
																		)}
																		{isError && toolMsg.params && (
																			<details className="mt-1">
																				<summary className="text-vibe-fg-3 cursor-pointer text-xs hover:text-vibe-fg-2">View params</summary>
																				<pre className="mt-1 p-2 bg-vibe-bg-2 rounded text-xs overflow-auto max-h-32 border border-vibe-border-1">
																					{JSON.stringify(toolMsg.params, null, 2)}
																				</pre>
																			</details>
																		)}
																	</div>
																);
															})}
														</div>
													</div>
												)}
												{step.files && step.files.length > 0 && (
													<div>
														<div className="text-vibe-fg-3 text-xs mb-2 font-medium">Files Affected:</div>
														<div className="flex flex-wrap gap-1.5">
															{step.files.map((file, i) => (
																<span key={i} className="px-2 py-0.5 bg-purple-500/10 text-purple-400 text-xs rounded border border-purple-500/20 flex items-center gap-1">
																	<File size={12} />
																	{file.split('/').pop()}
																</span>
															))}
														</div>
													</div>
												)}
												{step.error && (
													<div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-red-400 text-xs flex items-start gap-2">
														<AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
														<span>{step.error}</span>
													</div>
												)}
												{(step.startTime && step.endTime) && (
													<div className="text-vibe-fg-3 text-xs">
														Duration: {((step.endTime - step.startTime) / 1000).toFixed(1)}s
													</div>
												)}
												{step.checkpointIdx !== undefined && step.checkpointIdx !== null && (
													<div className="text-vibe-fg-3 text-xs">
														Checkpoint: #{step.checkpointIdx}
													</div>
												)}
											</div>
										)}
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</div>
	);
}, (prev, next) => {
	// Custom comparison: only re-render if plan message, checkpoint state, or thread changes
	return prev.message === next.message &&
		prev.isCheckpointGhost === next.isCheckpointGhost &&
		prev.threadId === next.threadId &&
		prev.messageIdx === next.messageIdx;
});

// Review Component - Shows summary after execution
const ReviewComponent = ({ message, isCheckpointGhost }: { message: ReviewMessage; isCheckpointGhost: boolean }) => {
	return (
		<div className={`${isCheckpointGhost ? 'opacity-50' : ''} my-2`}>
			<div className={`border rounded-lg p-4 ${
				message.completed
					? 'bg-green-500/10 border-green-500/30'
					: 'bg-amber-500/10 border-amber-500/30'
			}`}>
				<div className="flex items-center justify-between mb-3">
					<div className="flex items-center gap-2">
						{message.completed ? (
							<Check className="text-green-400" size={18} />
						) : (
							<AlertTriangle className="text-amber-400" size={18} />
						)}
						<h3 className={`font-semibold text-sm ${
							message.completed ? 'text-green-300' : 'text-amber-300'
						}`}>
							{message.completed ? 'Review Complete' : 'Review: Issues Found'}
						</h3>
					</div>
					{(message.executionTime || message.stepsCompleted !== undefined) && (
						<div className="text-xs text-vibe-fg-3">
							{message.executionTime && `${(message.executionTime / 1000).toFixed(1)}s`}
							{message.stepsCompleted !== undefined && message.stepsTotal !== undefined && (
								<span className="ml-2">
									{message.stepsCompleted}/{message.stepsTotal} steps
								</span>
							)}
						</div>
					)}
				</div>
				<p className="text-vibe-fg-2 text-sm mb-3">{message.summary}</p>

				{message.filesChanged && message.filesChanged.length > 0 && (
					<div className="mb-3">
						<h4 className="text-vibe-fg-2 text-xs font-semibold mb-2">Files Changed:</h4>
						<div className="space-y-1">
							{message.filesChanged.map((file, i) => (
								<div key={i} className="flex items-center gap-2 text-xs">
									{file.changeType === 'created' && <CirclePlus className="text-green-400" size={12} />}
									{file.changeType === 'modified' && <Pencil className="text-blue-400" size={12} />}
									{file.changeType === 'deleted' && <X className="text-red-400" size={12} />}
									<span className="text-vibe-fg-2">{file.path}</span>
								</div>
							))}
						</div>
					</div>
				)}

				{message.issues && message.issues.length > 0 && (
					<div className="space-y-2 mb-3">
						{message.issues.map((issue, i) => (
							<div key={i} className={`flex gap-2 text-sm p-2 rounded ${
								issue.severity === 'error' ? 'bg-red-500/10 border border-red-500/20' :
								issue.severity === 'warning' ? 'bg-amber-500/10 border border-amber-500/20' :
								'bg-blue-500/10 border border-blue-500/20'
							}`}>
								{issue.severity === 'error' ? (
									<X className="text-red-400 flex-shrink-0 mt-0.5" size={16} />
								) : issue.severity === 'warning' ? (
									<AlertTriangle className="text-amber-400 flex-shrink-0 mt-0.5" size={16} />
								) : (
									<Info className="text-blue-400 flex-shrink-0 mt-0.5" size={16} />
								)}
								<div className="flex-1">
									<p className={`${
										issue.severity === 'error' ? 'text-red-300' :
										issue.severity === 'warning' ? 'text-amber-300' :
										'text-blue-300'
									}`}>
										{issue.message}
									</p>
									{issue.file && (
										<p className="text-vibe-fg-3 text-xs mt-1 flex items-center gap-1">
											<File size={12} />
											{issue.file}
										</p>
									)}
								</div>
							</div>
						))}
					</div>
				)}

				{message.nextSteps && message.nextSteps.length > 0 && (
					<div className="mt-3 pt-3 border-t border-vibe-border-2">
						<p className="text-vibe-fg-3 text-xs mb-2 font-medium">Recommended Next Steps:</p>
						<ul className="space-y-1">
							{message.nextSteps.map((step, i) => (
								<li key={i} className="text-vibe-fg-2 text-xs flex items-start gap-2">
									<span className="text-vibe-fg-4 mt-1">•</span>
									<span>{step}</span>
								</li>
							))}
						</ul>
					</div>
				)}
			</div>
		</div>
	);
};

const ChatBubble = React.memo((props: ChatBubbleProps) => {
	return <ErrorBoundary>
		<div className="message-enter">
			<_ChatBubble {...props} />
		</div>
	</ErrorBoundary>;
}, (prev, next) => {
	// Custom comparison: only re-render if props actually changed
	return prev.chatMessage === next.chatMessage &&
		prev.messageIdx === next.messageIdx &&
		prev.isCommitted === next.isCommitted &&
		prev.chatIsRunning === next.chatIsRunning &&
		prev.currCheckpointIdx === next.currCheckpointIdx &&
		prev.threadId === next.threadId &&
		prev._scrollToBottom === next._scrollToBottom;
});

const _ChatBubble = React.memo(({ threadId, chatMessage, currCheckpointIdx, isCommitted, messageIdx, chatIsRunning, _scrollToBottom }: ChatBubbleProps) => {
	const role = chatMessage.role;

	const isCheckpointGhost = messageIdx > (currCheckpointIdx ?? Infinity) && !chatIsRunning; // whether to show as gray (if chat is running, for good measure just dont show any ghosts)

	if (role === 'user') {
		return <UserMessageComponent
			chatMessage={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
			currCheckpointIdx={currCheckpointIdx}
			messageIdx={messageIdx}
			_scrollToBottom={_scrollToBottom}
		/>;
	}
	else if (role === 'assistant') {
		return <AssistantMessageComponent
			chatMessage={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
			messageIdx={messageIdx}
			isCommitted={isCommitted}
		/>;
	}
	else if (role === 'tool') {

		if (chatMessage.type === 'invalid_params') {
			return <div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
				<InvalidTool toolName={chatMessage.name} message={chatMessage.content} mcpServerName={chatMessage.mcpServerName} />
			</div>;
		}

		const toolName = chatMessage.name;
		const isBuiltInTool = isABuiltinToolName(toolName);
		const ToolResultWrapper = isBuiltInTool ? builtinToolNameToComponent[toolName]?.resultWrapper as ResultWrapper<ToolName>
			: MCPToolWrapper as ResultWrapper<ToolName>;

		if (ToolResultWrapper)
			{return <>
				<div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
					<ToolResultWrapper
						toolMessage={chatMessage}
						messageIdx={messageIdx}
						threadId={threadId}
					/>
				</div>
				{chatMessage.type === 'tool_request' ?
					<div className={`${isCheckpointGhost ? 'opacity-50 pointer-events-none' : ''}`}>
						<ToolRequestAcceptRejectButtons toolName={chatMessage.name} />
					</div> : null}
			</>;}
		return null;
	}

	else if (role === 'interrupted_streaming_tool') {
		return <div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
			<CanceledTool toolName={chatMessage.name} mcpServerName={chatMessage.mcpServerName} />
		</div>;
	}

	else if (role === 'checkpoint') {
		return <Checkpoint
			threadId={threadId}
			message={chatMessage}
			messageIdx={messageIdx}
			isCheckpointGhost={isCheckpointGhost}
			threadIsRunning={!!chatIsRunning}
		/>;
	}

	else if (role === 'plan') {
		return <PlanComponent
			message={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
			threadId={threadId}
			messageIdx={messageIdx}
		/>;
	}

	else if (role === 'review') {
		return <ReviewComponent
			message={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
		/>;
	}

}, (prev, next) => {
	// Custom comparison for _ChatBubble
	return prev.chatMessage === next.chatMessage &&
		prev.messageIdx === next.messageIdx &&
		prev.isCommitted === next.isCommitted &&
		prev.chatIsRunning === next.chatIsRunning &&
		prev.currCheckpointIdx === next.currCheckpointIdx &&
		prev.threadId === next.threadId &&
		prev._scrollToBottom === next._scrollToBottom;
});

const CommandBarInChat = () => {
	const { stateOfURI: commandBarStateOfURI, sortedURIs: sortedCommandBarURIs } = useCommandBarState();
	const numFilesChanged = sortedCommandBarURIs.length;

	const accessor = useAccessor();
	const editCodeService = accessor.get('IEditCodeService');
	const commandService = accessor.get('ICommandService');
	const chatThreadsState = useChatThreadsState();
	const commandBarState = useCommandBarState();
	const chatThreadsStreamState = useChatThreadsStreamState(chatThreadsState.currentThreadId);

	// Chat → Markdown: Copy keeps tool-results truncated (small clipboard payload), Export writes
	// the full log to a .md file. Both serialize collapsed reasoning blocks regardless of UI state.
	const clipboardService = accessor.get('IClipboardService');
	const fileDialogService = accessor.get('IFileDialogService');
	const cmdBarFileService = accessor.get('IFileService');
	const cmdBarNotificationService = accessor.get('INotificationService');
	const exportThreadMarkdown = async (mode: 'copy' | 'export') => {
		const threadId = chatThreadsState.currentThreadId;
		const messages = (threadId ? chatThreadsState.allThreads[threadId]?.messages : undefined) ?? [];
		if (!messages.length) { cmdBarNotificationService.info(chatS.exportChatEmpty); return; }
		const md = threadToMarkdown(messages, { truncateToolResults: mode === 'copy' });
		try {
			if (mode === 'copy') {
				await clipboardService.writeText(md);
				cmdBarNotificationService.info(chatS.exportChatCopied);
			} else {
				const target = await fileDialogService.showSaveDialog({
					title: chatS.exportChatSaveTitle,
					filters: [{ name: 'Markdown', extensions: ['md'] }],
				});
				if (!target) { return; }
				await cmdBarFileService.writeFile(target, VSBuffer.fromString(md));
				cmdBarNotificationService.info(chatS.exportChatSaved);
			}
		} catch {
			cmdBarNotificationService.error(chatS.exportChatFailed);
		}
	};

	// (
	// 	<IconShell1
	// 		Icon={CopyIcon}
	// 		onClick={copyChatToClipboard}
	// 		data-tooltip-id='vibe-tooltip'
	// 		data-tooltip-place='top'
	// 		data-tooltip-content='Copy chat JSON'
	// 	/>
	// )

	const [fileDetailsOpenedState, setFileDetailsOpenedState] = useState<'auto-opened' | 'auto-closed' | 'user-opened' | 'user-closed'>('auto-closed');
	const isFileDetailsOpened = fileDetailsOpenedState === 'auto-opened' || fileDetailsOpenedState === 'user-opened';


	useEffect(() => {
		// close the file details if there are no files
		// this converts 'user-closed' to 'auto-closed'
		if (numFilesChanged === 0) {
			setFileDetailsOpenedState('auto-closed');
		}
		// open the file details if it hasnt been closed
		if (numFilesChanged > 0 && fileDetailsOpenedState !== 'user-closed') {
			setFileDetailsOpenedState('auto-opened');
		}
	}, [fileDetailsOpenedState, setFileDetailsOpenedState, numFilesChanged]);


	const isFinishedMakingThreadChanges = (
		// there are changed files
		commandBarState.sortedURIs.length !== 0
		// none of the files are streaming
		&& commandBarState.sortedURIs.every(uri => !commandBarState.stateOfURI[uri.fsPath]?.isStreaming)
	);

	// ======== status of agent ========
	// This icon answers the question "is the LLM doing work on this thread?"
	// assume it is single threaded for now
	// green = Running
	// orange = Requires action
	// dark = Done

    const threadStatus = (
        chatThreadsStreamState?.isRunning === 'awaiting_user'
            ? { title: chatS.statusNeedsApproval, color: 'yellow', } as const
            : (chatThreadsStreamState?.isRunning === 'LLM' || chatThreadsStreamState?.isRunning === 'tool' || chatThreadsStreamState?.isRunning === 'preparing')
                ? { title: chatThreadsStreamState?.isRunning === 'preparing' ? chatS.statusPreparing : chatS.statusRunning, color: 'orange', } as const
                : { title: chatS.statusDone, color: 'dark', } as const
    );


	const threadStatusHTML = <StatusIndicator className='mx-1' indicatorColor={threadStatus.color} title={threadStatus.title} />;


	// ======== info about changes ========
	// num files changed
	// acceptall + rejectall
	// popup info about each change (each with num changes + acceptall + rejectall of their own)

	const numFilesChangedStr = chatFilesWithChangesLabel(numFilesChanged);




	const acceptRejectAllButtons = <div
		// When visible: `ml-2` spaces the buttons from the status label. When hidden:
		// `w-0 overflow-hidden` collapses the horizontal footprint (not just opacity) so
		// the status label ("Готово") sits flush at the right edge instead of leaving a
		// phantom gap where the buttons were. Height is unaffected — the always-present
		// status indicator in the same row fixes the row height regardless of this width.
		className={`flex items-center gap-0.5
			${isFinishedMakingThreadChanges ? 'ml-2' : 'w-0 overflow-hidden opacity-0 pointer-events-none'}`
		}
	>
		<IconShell1 // RejectAllButtonWrapper
			// text="Reject All"
			// className="text-xs"
			Icon={X}
			onClick={() => {
				sortedCommandBarURIs.forEach(uri => {
					editCodeService.acceptOrRejectAllDiffAreas({
						uri,
						removeCtrlKs: true,
						behavior: "reject",
						_addToHistory: true,
					});
				});
			}}
			data-tooltip-id='vibe-tooltip'
			data-tooltip-place='top'
			data-tooltip-content={chatS.rejectAllTooltip}
		/>

		<IconShell1 // AcceptAllButtonWrapper
			// text="Accept All"
			// className="text-xs"
			Icon={Check}
			onClick={() => {
				sortedCommandBarURIs.forEach(uri => {
					editCodeService.acceptOrRejectAllDiffAreas({
						uri,
						removeCtrlKs: true,
						behavior: "accept",
						_addToHistory: true,
					});
				});
			}}
			data-tooltip-id='vibe-tooltip'
			data-tooltip-place='top'
			data-tooltip-content={chatS.acceptAllTooltip}
		/>



	</div>;


	// !select-text cursor-auto
	const fileDetailsContent = <div className="px-2 gap-1 w-full overflow-y-auto">
		{sortedCommandBarURIs.map((uri, i) => {
			const basename = getBasename(uri.fsPath);

			const { sortedDiffIds, isStreaming } = commandBarStateOfURI[uri.fsPath] ?? {};
			const isFinishedMakingFileChanges = !isStreaming;

			const numDiffs = sortedDiffIds?.length || 0;

			const fileStatus = (isFinishedMakingFileChanges
				? { title: chatS.statusDone, color: 'dark', } as const
				: { title: chatS.statusRunning, color: 'orange', } as const
			);

			const fileNameHTML = <div
				className="flex items-center gap-1.5 text-vibe-fg-3 hover:brightness-125 transition-all duration-200 cursor-pointer"
				onClick={() => voidOpenFileFn(uri, accessor)}
			>
				{/* <FileIcon size={14} className="text-vibe-fg-3" /> */}
				<span className="text-vibe-fg-3">{basename}</span>
			</div>;




			const detailsContent = <div className='flex px-4'>
				<span className="text-vibe-fg-3 opacity-80">{chatDiffCountLabel(numDiffs)}</span>
			</div>;

			const acceptRejectButtons = <div
				// Match the top-level command bar: when hidden, collapse WIDTH (not just opacity) so the
				// status label shifts flush to the right edge instead of leaving a phantom gap. Height is
				// unaffected — the always-present status indicator in the same row fixes the row height.
				className={`flex items-center gap-0.5
					${isFinishedMakingFileChanges ? 'ml-2' : 'w-0 overflow-hidden opacity-0 pointer-events-none'}
				`}
			>
				{/* <JumpToFileButton
					uri={uri}
					data-tooltip-id='vibe-tooltip'
					data-tooltip-place='top'
					data-tooltip-content='Go to file'
				/> */}
				<IconShell1 // RejectAllButtonWrapper
					Icon={X}
					onClick={() => { editCodeService.acceptOrRejectAllDiffAreas({ uri, removeCtrlKs: true, behavior: "reject", _addToHistory: true, }); }}
					data-tooltip-id='vibe-tooltip'
					data-tooltip-place='top'
					data-tooltip-content={chatS.rejectFileTooltip}

				/>
				<IconShell1 // AcceptAllButtonWrapper
					Icon={Check}
					onClick={() => { editCodeService.acceptOrRejectAllDiffAreas({ uri, removeCtrlKs: true, behavior: "accept", _addToHistory: true, }); }}
					data-tooltip-id='vibe-tooltip'
					data-tooltip-place='top'
					data-tooltip-content={chatS.acceptFileTooltip}
				/>

			</div>;

			const fileStatusHTML = <StatusIndicator className='mx-1' indicatorColor={fileStatus.color} title={fileStatus.title} />;

			return (
				// name, details
				<div key={i} className="flex justify-between items-center">
					<div className="flex items-center">
						{fileNameHTML}
						{detailsContent}
					</div>
					{/* Status first, accept/reject pinned right — identical to the top-level command bar,
					    so when the buttons collapse (while streaming) the status label shifts flush right. */}
					<div className="flex items-center">
						{fileStatusHTML}
						{acceptRejectButtons}
					</div>
				</div>
			);
		})}
	</div>;

	const fileDetailsButton = (
		<button
			className={`flex items-center gap-1 rounded ${numFilesChanged === 0 ? 'cursor-pointer' : 'cursor-pointer hover:brightness-125 transition-all duration-200'}`}
			onClick={() => isFileDetailsOpened ? setFileDetailsOpenedState('user-closed') : setFileDetailsOpenedState('user-opened')}
			type='button'
			disabled={numFilesChanged === 0}
		>
			<svg
				className="transition-transform duration-200 size-3.5"
				style={{
					transform: isFileDetailsOpened ? 'rotate(0deg)' : 'rotate(180deg)',
					transition: 'transform 0.2s cubic-bezier(0.25, 0.1, 0.25, 1)'
				}}
				xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"></polyline>
			</svg>
			{numFilesChangedStr}
		</button>
	);

	return (
		<>
			{/* file details */}
			<div className='px-2'>
				<div
					className={`
						select-none
						flex w-full rounded-t-lg bg-vibe-bg-3
						text-vibe-fg-3 text-xs text-nowrap

						overflow-hidden transition-all duration-200 ease-in-out
						${isFileDetailsOpened ? 'max-h-24' : 'max-h-0'}
					`}
				>
					{fileDetailsContent}
				</div>
			</div>
			{/* main content */}
			<div
				className={`
					select-none
					flex w-full rounded-t-lg bg-vibe-bg-3
					text-vibe-fg-3 text-xs text-nowrap
					border-t border-l border-r border-zinc-300/10

					px-2 py-1
					justify-between
				`}
			>
				<div className="flex gap-2 items-center">
					{fileDetailsButton}
					<IconShell1
						Icon={CopyIcon}
						onClick={() => { void exportThreadMarkdown('copy'); }}
						data-tooltip-id='vibe-tooltip'
						data-tooltip-place='top'
						data-tooltip-content={chatS.exportChatCopyTooltip}
					/>
					<IconShell1
						Icon={FileDown}
						onClick={() => { void exportThreadMarkdown('export'); }}
						data-tooltip-id='vibe-tooltip'
						data-tooltip-place='top'
						data-tooltip-content={chatS.exportChatExportTooltip}
					/>
				</div>
				{/* Status indicator FIRST so the accept/reject-all buttons stay pinned to the
				    right edge and never shift horizontally when the status label width changes
				    (e.g. "Думаю…" → "Готово"). Previously buttons came first and moved with the
				    group's left edge, causing accept↔reject misclicks. */}
				<div className="flex items-center">
					{threadStatusHTML}
					{acceptRejectAllButtons}
				</div>
			</div>
		</>
	);
};



const EditToolSoFar = ({ toolCallSoFar, }: { toolCallSoFar: RawToolCallObj }) => {

	if (!isABuiltinToolName(toolCallSoFar.name)) {return null;}

	const accessor = useAccessor();

	const uri = toolCallSoFar.rawParams.uri ? URI.file(toolCallSoFar.rawParams.uri) : undefined;

	const title = titleOfBuiltinToolName[toolCallSoFar.name]?.proposed ?? toolCallSoFar.name;

	const uriDone = toolCallSoFar.doneParams.includes('uri');
	const desc1 = <span className='flex items-center gap-1'>
		{uriDone ?
			getBasename(toolCallSoFar.rawParams['uri'] ?? 'unknown')
			: `Generating`}
		<IconLoading state="processing" inline />
	</span>;

	const desc1OnClick = () => { if (uri) { voidOpenFileFn(uri, accessor); } };

	// If URI has not been specified
	return <ToolHeaderWrapper
		title={title}
		desc1={desc1}
		desc1OnClick={desc1OnClick}
	>
		<EditToolChildren
			uri={uri}
			code={toolCallSoFar.rawParams.search_replace_blocks ?? toolCallSoFar.rawParams.new_content ?? ''}
			type={'rewrite'} // as it streams, show in rewrite format, don't make a diff editor
		/>
		<IconLoading state="processing" inline />
	</ToolHeaderWrapper>;

};


export const SidebarChat = () => {
	trackRenderLoop('SidebarChat');
	const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
	const textAreaFnsRef = useRef<TextAreaFns | null>(null);

	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const chatThreadsService = accessor.get('IChatThreadService');
	const notificationService = accessor.get('INotificationService');

	const settingsState = useSettingsState();
	// ----- HIGHER STATE -----

	// threads state
	const chatThreadsState = useChatThreadsState();

	const currentThread = chatThreadsService.getCurrentThread();
	const previousMessages = currentThread?.messages ?? [];

	const selections = currentThread.state.stagingSelections;
	const setSelections = (s: StagingSelectionItem[]) => { chatThreadsService.setCurrentThreadState({ stagingSelections: s }); };

	// stream state
	const currThreadStreamState = useChatThreadsStreamState(chatThreadsState.currentThreadId);
	const isRunning = currThreadStreamState?.isRunning;
	const latestError = currThreadStreamState?.error;
	const { displayContentSoFar, toolCallSoFar, reasoningSoFar } = currThreadStreamState?.llmInfo ?? {};

	// this is just if it's currently being generated, NOT if it's currently running
	const toolIsGenerating = toolCallSoFar && !toolCallSoFar.isDone; // show loading for slow tools (right now just edit)

	// ----- SIDEBAR CHAT state (local) -----

	// state of current message
	const initVal = '';
	const [instructionsAreEmpty, setInstructionsAreEmpty] = useState(!initVal);

	// Per-thread composer draft. The chat is ONE mounted component shared across tabs (refactor B),
	// so on tab switch we save the outgoing thread's unsent text and restore the incoming thread's.
	// Without this the single composer loses drafts on switch / bleeds text between tabs.
	useEffect(() => {
		// Restore this thread's draft into the composer on mount/switch. Drafts are saved on each
		// keystroke (onChangeText) + cleared on send, so no unmount-time save is needed here.
		const saved = chatThreadsService.getThreadDraft(chatThreadsState.currentThreadId);
		textAreaFnsRef.current?.setValue(saved);
		setInstructionsAreEmpty(!saved);
	}, [chatThreadsState.currentThreadId]);

	// ── Per-tab chat config (model / mode / autopilot / iterations) ──────────────────────────────
	// Each chat tab keeps its own config. SidebarChat is keyed by thread (see Sidebar.tsx), so this
	// instance == one tab: on mount we APPLY the tab's saved config to the global stores (or snapshot
	// the current globals if the tab has none yet); on any control change we SAVE the globals back into
	// this tab. Writes go to the thread (not the globals), so there's no apply→save→apply loop.
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const configurationService = accessor.get('IConfigurationService');
	const SOFT_CHECKPOINT_ITER_KEY = 'vibeide.agent.softCheckpointIterations';
	const readIter = useCallback((): number => {
		const r = configurationService.getValue<unknown>(SOFT_CHECKPOINT_ITER_KEY);
		// Fallback mirrors the registered config default (0 = ∞ / no pauses).
		return (typeof r === 'number' && Number.isFinite(r) && r >= 0) ? Math.floor(r) : 0;
	}, [configurationService]);
	const [iterValue, setIterValue] = useState<number>(readIter);
	useEffect(() => {
		const d = configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SOFT_CHECKPOINT_ITER_KEY)) { setIterValue(readIter()); }
		});
		return () => d.dispose();
	}, [configurationService, readIter]);

	const curModelSel = settingsState.modelSelectionOfFeature['Chat'] ?? null;
	const curChatMode = settingsState.globalSettings.chatMode;
	const curAutopilot = settingsState.globalSettings.chatAgentAutopilot === true;
	const readChatConfig = useCallback(() => ({
		model: curModelSel ? { providerName: curModelSel.providerName, modelName: curModelSel.modelName } : null,
		chatMode: curChatMode as string,
		autopilot: curAutopilot,
		iterations: iterValue,
	}), [curModelSel, curChatMode, curAutopilot, iterValue]);

	// Apply saved config (or snapshot current) once on mount/tab-switch.
	useEffect(() => {
		const cfg = chatThreadsService.getCurrentThread()?.chatConfig;
		if (cfg) {
			const model = cfg.model;
			if (model && isProviderName(model.providerName)) {
				void vibeideSettingsService.setModelSelectionOfFeature('Chat', { providerName: model.providerName, modelName: model.modelName });
			}
			if (isChatMode(cfg.chatMode)) {
				void vibeideSettingsService.setGlobalSetting('chatMode', cfg.chatMode);
			}
			void vibeideSettingsService.setGlobalSetting('chatAgentAutopilot', cfg.autopilot);
			void configurationService.updateValue(SOFT_CHECKPOINT_ITER_KEY, cfg.iterations);
		} else {
			chatThreadsService.setThreadChatConfig(currentThread.id, readChatConfig());
		}
	}, []);

	// Save config into this tab on any control change. Skip the first run (mount) so the apply above
	// can propagate; the second run (triggered by the apply's global changes) writes the applied config
	// back — a no-op via the service's JSON-equality guard. Genuine user changes are saved thereafter.
	const skipFirstCfgSaveRef = useRef(true);
	useEffect(() => {
		if (skipFirstCfgSaveRef.current) { skipFirstCfgSaveRef.current = false; return; }
		chatThreadsService.setThreadChatConfig(currentThread.id, readChatConfig());
	}, [curModelSel?.providerName, curModelSel?.modelName, curChatMode, curAutopilot, iterValue]);

	// Image attachments management
	const {
		attachments: imageAttachments,
		addImages: addImagesRaw,
		removeImage,
		retryImage,
		cancelImage,
		clearAll: clearImages,
		focusedIndex: focusedImageIndex,
		setFocusedIndex: setFocusedImageIndex,
		validationError: imageValidationError,
	} = useImageAttachments();

	// PDF attachments management
	const {
		attachments: pdfAttachments,
		addPDFs: addPDFsRaw,
		removePDF,
		retryPDF,
		cancelPDF,
		clearAll: clearPDFs,
		focusedIndex: focusedPDFIndex,
		setFocusedIndex: setFocusedPDFIndex,
		validationError: pdfValidationError,
	} = usePDFAttachments();

	// Wrapper to check vision capabilities before adding PDFs
	// PDFs are more forgiving than images - they can work with non-vision models via text extraction
	const addPDFs = useCallback(async (files: File[]) => {
		const currentModelSel = settingsState.modelSelectionOfFeature['Chat'];

		// In auto mode, skip vision capability check - the router will select an appropriate model
		// PDFs can also work with non-vision models via text extraction, so we're more lenient
		if (currentModelSel?.providerName === 'auto' && currentModelSel?.modelName === 'auto') {
			await addPDFsRaw(files);
			return;
		}

		// For non-auto mode, allow PDFs even without vision models (they can use text extraction)
		// But we could optionally warn if no vision models are available
		await addPDFsRaw(files);
	}, [addPDFsRaw, settingsState]);

	// Always attach images. Surface a non-blocking hint if the selected model isn't vision-capable
	// so the user can switch models before sending. Parity with PDF behavior.
	const addImages = useCallback(async (files: File[]) => {
		await addImagesRaw(files);

		const currentModelSel = settingsState.modelSelectionOfFeature['Chat'];

		// In auto mode the router picks a vision-capable model — no warning needed
		if (currentModelSel?.providerName === 'auto' && currentModelSel?.modelName === 'auto') {return;}

		const { isSelectedModelVisionCapable, checkOllamaModelVisionCapable, isOllamaAccessible } = await import('../util/visionModelHelper.js');

		let selectedIsVision = isSelectedModelVisionCapable(currentModelSel, settingsState.settingsOfProvider);
		if (!selectedIsVision && currentModelSel?.providerName === 'ollama') {
			const ollamaAccessible = await isOllamaAccessible();
			if (ollamaAccessible) {
				selectedIsVision = await checkOllamaModelVisionCapable(currentModelSel.modelName);
			}
		}

		if (!selectedIsVision) {
			const notificationService = accessor.get('INotificationService');
			const commandService = accessor.get('ICommandService');
			notificationService.notify({
				severity: 1, // Severity.Info
				message: 'Выбранная модель, похоже, не поддерживает изображения. Переключитесь на vision-модель (Claude, GPT-4, Gemini или Ollama-модель вроде llava), чтобы использовать прикреплённую картинку.',
				actions: {
					primary: [{
						id: 'vibe.vision.setup',
						label: 'Открыть настройки',
						tooltip: '',
						class: undefined,
						enabled: true,
						run: () => commandService.executeCommand(VIBEIDE_OPEN_SETTINGS_ACTION_ID),
					}],
				},
			});
		}
	}, [addImagesRaw, settingsState, accessor]);

	// Compute isDisabled - ensure it's reactive to settings changes
	const isDisabled = useMemo(() => {
		return (instructionsAreEmpty && imageAttachments.length === 0 && pdfAttachments.length === 0) || !!isFeatureNameDisabled('Chat', settingsState);
	}, [instructionsAreEmpty, imageAttachments.length, pdfAttachments.length, settingsState]);

	const sidebarRef = useRef<HTMLDivElement>(null);
	const virtuosoRef = useRef<VirtuosoHandle | null>(null);

	// Tracks whether the user is scrolled to (or near) the bottom. Used by
	// `followOutput` so streaming chunks only auto-scroll when the user hasn't
	// scrolled up to read earlier history. Virtuoso fires this via `atBottomStateChange`.
	const isAtBottomRef = useRef(true);
	// Reactive mirror of the ref — drives the floating "jump to bottom" button. Virtuoso fires
	// atBottomStateChange only on transitions (not every pixel), so the setState is cheap.
	const [atBottom, setAtBottom] = useState(true);
	const handleAtBottomStateChange = useCallback((isBottom: boolean) => {
		isAtBottomRef.current = isBottom;
		setAtBottom(isBottom);
	}, []);

	// Same callback signature as before (called by `chatThreadService.whenMounted.then(m => m.scrollToBottom())`
	// after a user message is sent, and by `UserMessageComponent` inside requestAnimationFrame).
	// Internally now scrolls Virtuoso to the last item; this is async (one frame later)
	// but the callers are fire-and-forget, so the contract is preserved.
	const scrollToBottomCallback = useCallback(() => {
		virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto', align: 'end' });
	}, []);

	const onSubmit = useCallback(async (_forceSubmit?: string) => {

		if (isDisabled && !_forceSubmit) {return;}
		if (isRunning) {return;}

		// use subscribed state - currentThread.id is already from subscribed state
		const threadId = currentThread.id;

		// hoisted: used both inside the @-resolver try-block and later in vision/PDF validation
		const notificationService = accessor.get('INotificationService');

		// send message to LLM
		const userMessage = _forceSubmit || textAreaRef.current?.value || '';

			// Resolve @references in the input into staging selections before sending
			// Supports tokens like: @"src/app/file.ts", @path/to/file.ts, @folder, @workspace, @recent, @selection, @agent
			try {
				const toolsService = accessor.get('IToolsService');
				const workspaceService = accessor.get('IWorkspaceContextService');
				const editorService = accessor.get('IEditorService');
				const languageService = accessor.get('ILanguageService');
				const historyService = accessor.get('IHistoryService');
				const fileService = accessor.get('IFileService');
				let outlineService: any = undefined;
				try { outlineService = accessor.get('IOutlineModelService'); } catch {}

			// Collect existing URIs to avoid duplicate attachments
			const existing = new Set<string>();
			const existingSelections = chatThreadsState.allThreads[currentThread.id]?.state?.stagingSelections || [];
			for (const s of existingSelections) {existing.add(s.uri?.fsPath || '');}

			const addFileSelection = async (uri: any) => {
				if (!uri) {return;}
				const key = uri.fsPath || uri.path || '';
				if (key && existing.has(key)) {return;}
				existing.add(key);
				const newSel = {
					type: 'File',
					uri,
					language: languageService.guessLanguageIdByFilepathOrFirstLine(uri) || '',
					state: { wasAddedAsCurrentFile: false },
				};
				await chatThreadsService.addNewStagingSelection(newSel);
			};

			const addFolderSelection = async (uri: any) => {
				if (!uri) {return;}
				const key = uri.fsPath || uri.path || '';
				if (key && existing.has(key)) {return;}
				existing.add(key);
				const newSel = {
					type: 'Folder',
					uri,
					language: undefined,
					state: undefined,
				};
				await chatThreadsService.addNewStagingSelection(newSel);
			};

			const tokens: string[] = [];
			{
				// Extract quoted paths first: @"..."
				const quoted = [...userMessage.matchAll(/@"([^"]+)"/g)].map(m => m[1]);
				tokens.push(...quoted);
				// Extract bare @word-like tokens (stop at whitespace or punctuation)
				for (const m of userMessage.matchAll(/@([\w\.\-_/]+(?::\d+(?:-\d+)?)?)/g)) {
					const t = m[1];
					if (t) {tokens.push(t);}
				}
			}

			const special = new Set(['selection', 'workspace', 'recent', 'folder', 'agent']);

			// Track unresolved references for error reporting
			const unresolvedRefs: string[] = [];

			for (const raw of tokens) {
				// Handle special tokens
				if (raw === 'selection') {
					const active = editorService.activeTextEditorControl;
					const activeResource = editorService.activeEditor?.resource;
					const sel = active?.getSelection?.();
					if (activeResource && sel && !sel.isEmpty()) {
						const newSel = {
							type: 'File',
							uri: activeResource,
							language: languageService.guessLanguageIdByFilepathOrFirstLine(activeResource) || '',
							state: { wasAddedAsCurrentFile: false },
							range: sel,
						};
						const key = activeResource.fsPath || '';
						if (!existing.has(key)) {
							existing.add(key);
							await chatThreadsService.addNewStagingSelection(newSel);
						}
					} else {
						unresolvedRefs.push('@selection (no active selection)');
					}
					continue;
				}
				if (raw === 'workspace') {
					for (const folder of workspaceService.getWorkspace().folders) {
						await addFolderSelection(folder.uri);
					}
					continue;
				}
				if (raw === 'agent') {
					for (const folder of workspaceService.getWorkspace().folders) {
						const candidates = [
							URI.joinPath(folder.uri, 'AGENTS.md'),
							URI.joinPath(folder.uri, '.vibe', 'rules.md'),
						];
						for (const uri of candidates) {
							try {
								if (await fileService.exists(uri)) {
									await addFileSelection(uri);
								}
							} catch {
								// ignore missing or inaccessible paths
							}
						}
					}
					continue;
				}
				if (raw === 'recent') {
					for (const h of historyService.getHistory()) {
						if (h.resource) {await addFileSelection(h.resource);}
					}
					continue;
				}

				// Handle explicit symbol: @sym:Name or @symbol:Name
				if (raw.startsWith('sym:') || raw.startsWith('symbol:')) {
					const symName = raw.replace(/^symbol?:/,'');
					let symbolFound = false;
					if (outlineService && typeof outlineService.getCachedModels === 'function') {
						try {
							const models = outlineService.getCachedModels();
							for (const om of models) {
								const list = typeof om.asListOfDocumentSymbols === 'function' ? om.asListOfDocumentSymbols() : [];
								for (const s of list) {
									if ((s?.name || '').toLowerCase() === symName.toLowerCase()) {
										symbolFound = true;
										const uri = om.uri;
										const range = s.range;
										const key = uri?.fsPath || '';
										if (!existing.has(key)) {
											existing.add(key);
											await chatThreadsService.addNewStagingSelection({
												type: 'File',
												uri,
												language: languageService.guessLanguageIdByFilepathOrFirstLine(uri) || '',
												state: { wasAddedAsCurrentFile: false },
												range,
											});
										}
									}
								}
							}
						} catch (err) {
							// Service error - log but continue
							vibeLog.warn('SidebarChat', 'Error resolving symbol:', err);
						}
					}
					if (!symbolFound) {
						unresolvedRefs.push(`@${raw} (symbol not found)`);
					}
					continue;
				}

				// Handle explicit folder keyword like: @folder:path or plain name that matches a folder
				let query = raw;
				let isFolderHint = false;
				if (raw.startsWith('folder:')) {
					isFolderHint = true;
					query = raw.slice('folder:'.length);
				}

				// Use tools service to resolve best match in workspace
				let resolved = false;
				try {
					const res = await (await toolsService.callTool.search_pathnames_only({ query, includePattern: null, pageNumber: 1 })).result;
					const [first] = res.uris || [];
					if (first) {
						resolved = true;
						// Heuristic: if hint says folder or resolved path ends with '/', treat as folder
						if (isFolderHint) {await addFolderSelection(first);}
						else {await addFileSelection(first);}
					}
				} catch (err) {
					// Service error - log but continue
					vibeLog.warn('SidebarChat', 'Error resolving reference:', err);
				}
				if (!resolved) {
					unresolvedRefs.push(`@${raw}`);
				}
			}

			// Report unresolved references to user
			if (unresolvedRefs.length > 0) {
				const refList = unresolvedRefs.slice(0, 3).join(', ');
				const moreText = unresolvedRefs.length > 3 ? ` and ${unresolvedRefs.length - 3} more` : '';
				notificationService.warn(`Could not resolve reference${unresolvedRefs.length > 1 ? 's' : ''}: ${refList}${moreText}. Please check the file path or symbol name.`);
			}
		} catch (err) {
			// Best-effort; do not block send, but log error
			vibeLog.warn('SidebarChat', 'Error resolving @references:', err);
		}

		// Convert image attachments to ChatImageAttachment format
		const images: ChatImageAttachment[] = imageAttachments
			.filter(att => att.uploadStatus === 'success' || !att.uploadStatus)
			.map(att => ({
				id: att.id,
				data: att.data,
				mimeType: att.mimeType,
				filename: att.filename,
				width: att.width,
				height: att.height,
				size: att.size,
			}));

		// Check if any PDFs are still processing
		const processingPDFs = pdfAttachments.filter(
			att => att.uploadStatus === 'uploading' || att.uploadStatus === 'processing'
		);

		if (processingPDFs.length > 0) {
			const processingNames = processingPDFs.map(p => p.filename).join(', ');
			notificationService.warn(`Some PDFs are still processing: ${processingNames}. They will be sent but may not have extracted text available yet.`);
		}

		// Convert PDF attachments to ChatPDFAttachment format
		// Include PDFs that are successful, have no status, or are still processing (they might have partial data)
		// Exclude only failed PDFs
		const pdfs: ChatPDFAttachment[] = pdfAttachments
			.filter(att => att.uploadStatus !== 'failed')
			.map(att => ({
				id: att.id,
				data: att.data,
				filename: att.filename,
				size: att.size,
				pageCount: att.pageCount,
				selectedPages: att.selectedPages,
				extractedText: att.extractedText,
				pagePreviews: att.pagePreviews,
			}));

		// Validate that model supports vision/PDFs if attachments are present
		const currentModelSel = settingsState.modelSelectionOfFeature['Chat'];
		if ((images.length > 0 || pdfs.length > 0) && currentModelSel) {
			const { isSelectedModelVisionCapable, checkOllamaModelVisionCapable, hasVisionCapableApiKey, hasOllamaVisionModel, isOllamaAccessible } = await import('../util/visionModelHelper.js');

			// In auto mode, check if user has any vision-capable models available
			if (currentModelSel.providerName === 'auto' && currentModelSel.modelName === 'auto') {
				// Images need vision-capable models — warn but don't block (the provider will surface its own error if it can't process the image)
				if (images.length > 0) {
					const hasApiKey = hasVisionCapableApiKey(settingsState.settingsOfProvider, currentModelSel, settingsState.overridesOfModel);
					const ollamaAccessible = await isOllamaAccessible();
					const hasOllamaVision = ollamaAccessible && await hasOllamaVisionModel();

					if (!hasApiKey && !hasOllamaVision) {
						notificationService.warn('No vision-capable models detected. The image will be sent, but the model may not be able to read it. Set up an API key (Claude, GPT-4, Gemini) or an Ollama vision model (llava, bakllava) for proper image support.');
					}
				}
				// PDFs can work with non-vision models via text extraction, so we allow them even without vision-capable models
				// If vision-capable models are available, router will select appropriate model
			} else {
				// For non-auto mode, check if the selected model is vision-capable
				let isVisionCapable = isSelectedModelVisionCapable(currentModelSel, settingsState.settingsOfProvider, settingsState.overridesOfModel);

				// If Ollama, check via API
				if (!isVisionCapable && currentModelSel.providerName === 'ollama') {
					const ollamaAccessible = await isOllamaAccessible();
					if (ollamaAccessible) {
						isVisionCapable = await checkOllamaModelVisionCapable(currentModelSel.modelName);
					}
				}

				// Hard-block when an image is attached to a non-vision model — silently dropping
				// images and continuing causes the model to hallucinate "what it sees" based on
				// the system prompt. PDFs are extracted to text upstream, so they keep flowing.
				if (!isVisionCapable && images.length > 0) {
					notificationService.error(`Выбранная модель (${displayInfoOfProviderName(currentModelSel.providerName).title}/${currentModelSel.modelName}) не поддерживает изображения. Переключитесь на vision-модель (Claude, GPT-4o/4.1/5, Gemini, vision-модель OpenRouter или Ollama llava/bakllava) либо удалите вложение.`);
					return;
				}
				if (!isVisionCapable && pdfs.length > 0) {
					notificationService.warn('Выбранная модель может не поддерживать PDF. Текст из PDF будет извлечён и отправлен — для PDF с большим количеством картинок выберите vision-модель.');
				}
			}
		}

		// Capture staging selections BEFORE clearing them, so they're included in the message
		const stagingSelections = chatThreadsState.allThreads[currentThread.id]?.state?.stagingSelections || [];

		// Optimistic UI: Clear input and attachments immediately for perceived responsiveness
		setSelections([]); // clear staging
		if (textAreaFnsRef.current) {
			textAreaFnsRef.current.setValue('');
		}
		chatThreadsService.setThreadDraft(currentThread.id, ''); // drop the saved draft once sent
		clearImages(); // clear image attachments
		clearPDFs(); // clear PDF attachments
		textAreaRef.current?.focus(); // focus input after submit

		// Send message (non-blocking for UI responsiveness)
		try {
			await chatThreadsService.addUserMessageAndStreamResponse({ userMessage, threadId, images, pdfs, _chatSelections: stagingSelections });
		} catch (e) {
			vibeLog.error('SidebarChat', 'Error while sending message in chat:', e);
		}

	}, [chatThreadsService, isDisabled, isRunning, textAreaRef, textAreaFnsRef, setSelections, settingsState, imageAttachments, pdfAttachments, clearImages, clearPDFs, currentThread.id]);

	const onAbort = async () => {
		const threadId = currentThread.id;
		await chatThreadsService.abortRunning(threadId);
	};

	// Queue the typed text as context for the agent's NEXT hop WITHOUT aborting the running turn.
	// Drained into a real user message at the top of the next hop (chatThreadService).
	// See docs/knowledge/chat-ux/chat-interrupt-and-inject.md.
	const onInject = useCallback(() => {
		const threadId = currentThread.id;
		const val = textAreaRef.current?.value ?? '';
		if (!val.trim()) { return; }
		// Queue the note; it surfaces immediately as a pinned "queued" chip above the input (see the
		// pendingInjections strip below), so no toast is needed.
		chatThreadsService.addPendingInjection(threadId, val);
		if (textAreaFnsRef.current) { textAreaFnsRef.current.setValue(''); }
		chatThreadsService.setThreadDraft(threadId, '');
		textAreaRef.current?.focus();
	}, [chatThreadsService, currentThread.id, textAreaRef, textAreaFnsRef]);

	const keybindingString = accessor.get('IKeybindingService').lookupKeybinding(VIBEIDE_CTRL_L_ACTION_ID)?.getLabel();

	const threadId = currentThread.id;
	const currCheckpointIdx = chatThreadsState.allThreads[threadId]?.state?.currCheckpointIdx ?? undefined;  // if not exist, treat like checkpoint is last message (infinity)
	// Notes the user queued mid-run (via onInject). Shown as a pinned "queued" strip above the input until
	// the agent drains them into a real message on its next hop (then pendingInjections clears → strip gone).
	const pendingInjections = chatThreadsState.allThreads[threadId]?.state?.pendingInjections ?? [];



	// resolve mount info
	// Accessing .current is safe - refs don't trigger re-renders when changed
	const mountedInfo = chatThreadsState.allThreads[threadId]?.state.mountedInfo;
	const isResolved = mountedInfo?.mountedIsResolvedRef.current;
	useEffect(() => {
		if (isResolved) {return;}
		mountedInfo?._whenMountedResolver?.({
			textAreaRef: textAreaRef,
			scrollToBottom: scrollToBottomCallback,
		});

	}, [threadId, textAreaRef, isResolved, mountedInfo, scrollToBottomCallback]);




	const streamingChatIdx = previousMessages.length;
	// Memoize chatMessage object to avoid recreating on every render
	const streamingChatMessage = useMemo(() => ({
		role: 'assistant' as const,
		displayContent: displayContentSoFar ?? '',
		reasoning: reasoningSoFar ?? '',
		anthropicReasoning: null,
	}), [displayContentSoFar, reasoningSoFar]);

	// Only show streaming message when actively streaming (LLM, tool, or preparing)
	// Don't show when idle/undefined to prevent duplicate messages and never-ending loading
	// Only show stop button when actively running (LLM, tool, preparing), not when idle
	const isActivelyStreaming = isRunning === 'LLM' || isRunning === 'tool' || isRunning === 'preparing';
	const isWaitingForModelSentinel = isActivelyStreaming
		&& displayContentSoFar === WAITING_FOR_MODEL_RESPONSE_SENTINEL
		&& !reasoningSoFar;
	const currStreamingMessageHTML = isWaitingForModelSentinel ?
		<ProseWrapper key={'curr-streaming-msg'}>
			<div
				className="flex items-center gap-2 loading-state-transition"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				<IconLoading state="thinking" />
				<span className="text-sm text-vibe-fg-2 opacity-80">Waiting for model response</span>
			</div>
		</ProseWrapper>
		: isActivelyStreaming && (reasoningSoFar || displayContentSoFar) ?
			<ChatBubble
				key={'curr-streaming-msg'}
				currCheckpointIdx={currCheckpointIdx}
				chatMessage={streamingChatMessage}
				messageIdx={streamingChatIdx}
				isCommitted={false}
				chatIsRunning={isRunning}
				threadId={threadId}
				_scrollToBottom={null}
			/> : null;


	// the tool currently being generated
	const generatingTool = toolIsGenerating ?
		toolCallSoFar.name === 'edit_file' || toolCallSoFar.name === 'rewrite_file' ? <EditToolSoFar
			key={'curr-streaming-tool'}
			toolCallSoFar={toolCallSoFar}
		/>
			: null
		: null;

	// Build a single virtualized data array: real messages + transient extras
	// (streaming bubble, stall banner, generating tool, loading indicator, escape
	// hint, error block). Keeping everything in `data` lets Virtuoso's followOutput
	// auto-pin the viewport to the bottom whenever the last item grows during
	// streaming — no Footer measurement workarounds needed.
	const chatItems = useMemo(() => {
		const items: Array<{ key: string; render: () => React.ReactNode }> = [];

		// Real history. Defensive: thread state can occasionally produce two messages
		// with the same id (e.g. a tool message duplicated by a retry/resume path).
		// React requires globally unique keys, so we suffix repeats with #N — the
		// first occurrence keeps the bare id for stable reconciliation.
		const seen = new Map<string, number>();
		previousMessages.forEach((message, i) => {
			const messageId = (message as Readonly<Record<string, unknown>>).id;
			const baseKey = (typeof messageId === 'string' && messageId) || `msg-${i}`;
			const count = seen.get(baseKey) ?? 0;
			seen.set(baseKey, count + 1);
			const key = count === 0 ? baseKey : `${baseKey}#${count}`;
			items.push({
				key,
				render: () => <ChatBubble
					currCheckpointIdx={currCheckpointIdx}
					chatMessage={message}
					messageIdx={i}
					isCommitted={true}
					chatIsRunning={isRunning}
					threadId={threadId}
					_scrollToBottom={scrollToBottomCallback}
				/>
			});
		});

		// Streaming bubble (assistant response in progress) or "waiting for model" sentinel.
		if (currStreamingMessageHTML) {
			items.push({ key: 'curr-streaming-msg', render: () => currStreamingMessageHTML });
		}

		// Stall recovery banner — when LLM watchdog detects no new tokens within EARLY_STALL_MS.
		if (currThreadStreamState?.isRunning === 'LLM' && currThreadStreamState.stallInfo) {
			const stalledAt = currThreadStreamState.stallInfo.stalledAt;
			items.push({
				key: 'stall-banner',
				render: () => <StallBanner
					stalledAt={stalledAt}
					onAbort={() => { chatThreadsService.abortRunning(threadId); }}
					onRetry={() => { chatThreadsService.retryStalledStream(threadId); }}
				/>
			});
		}

		// Rate-limit auto-pause countdown — provider asked us to wait; the run resumes automatically.
		if (currThreadStreamState?.isRunning === undefined && currThreadStreamState?.pauseInfo) {
			const { resumeAtMs, attempt, maxAttempts } = currThreadStreamState.pauseInfo;
			items.push({
				key: 'rate-limit-pause-banner',
				render: () => <RateLimitPauseBanner
					resumeAtMs={resumeAtMs}
					attempt={attempt}
					maxAttempts={maxAttempts}
					onResumeNow={() => { chatThreadsService.resumeRateLimitPauseNow(threadId); }}
				/>
			});
		}

		// Generating-tool preview (edit_file / rewrite_file in progress).
		if (generatingTool) {
			items.push({ key: 'generating-tool', render: () => generatingTool });
		}

		// Loading indicator — only when no content is streaming yet.
		if ((isRunning === 'LLM' || isRunning === 'preparing') && !displayContentSoFar && !reasoningSoFar) {
			items.push({
				key: 'loading-indicator',
				render: () => <ProseWrapper>
					<div className="flex items-center gap-3 loading-state-transition" role="status" aria-live="polite" aria-atomic="true">
						<span className="text-vibe-fg-2 opacity-70 flex-shrink-0 text-base leading-none">
							<IconLoading state={isRunning === 'preparing' ? 'thinking' : 'processing'} />
						</span>
						<div className="flex flex-col gap-0.5">
							<span className="text-sm text-vibe-fg-2 opacity-80">
								{isRunning === 'preparing' && currThreadStreamState?.llmInfo?.displayContentSoFar
									? currThreadStreamState.llmInfo.displayContentSoFar
									: isRunning === 'preparing'
										? 'Preparing request…'
										: 'Generating response…'}
							</span>
							<span className="text-[11px] text-vibe-fg-3 opacity-50">Press Escape to cancel</span>
						</div>
					</div>
				</ProseWrapper>
			});
		}

		// Escape hint when streaming.
		if ((isRunning === 'LLM' || isRunning === 'preparing') && (displayContentSoFar || reasoningSoFar)) {
			items.push({
				key: 'escape-hint',
				render: () => <p className="text-xs text-vibe-fg-3 opacity-60 mt-1" role="status">Press Escape to cancel</p>
			});
		}

		// Error block.
		if (latestError !== undefined) {
			const _err = latestError as { message: string; fullError: Error | null; recoverable?: 'dismissPlan' | 'forceReset' | 'switchModel' | 'retry' };
			const isPendingPlanGate = _err.recoverable === 'dismissPlan';
			const isForceReset = _err.recoverable === 'forceReset';
			const isSwitchModel = _err.recoverable === 'switchModel';
			const isRetry = _err.recoverable === 'retry';
			items.push({
				key: 'error-block',
				render: () => <div className='px-2 my-1 message-enter space-y-2'>
					<ErrorDisplay
						message={_err.message}
						fullError={_err.fullError}
						onDismiss={() => { chatThreadsService.dismissStreamError(currentThread.id); }}
						showDismiss={true}
					/>
					{isPendingPlanGate ? (
						// Permanent action button — visible even after the user closes the toast.
						// One click dismisses every pending plan in this thread; the chat error
						// clears on its own as soon as `dismissAllPendingPlans` returns >0 and
						// the command resets streamState.
						<WarningBox
							className='text-sm my-1 mx-3'
							onClick={() => { commandService.executeCommand('vibeide.chat.dismissPendingPlan'); }}
							text='Сбросить план и продолжить'
						/>
					) : isForceReset ? (
						// Submit watchdog detected a stuck running-state — UI offers a
						// one-click force-reset instead of forcing an IDE restart. Calls
						// chatThreadsService.forceResetChatState() directly (no command
						// indirection — keeps the recovery path single-file).
						<WarningBox
							className='text-sm my-1 mx-3'
							onClick={() => { chatThreadsService.forceResetChatState(currentThread.id); }}
							text='Сбросить состояние чата'
						/>
					) : isSwitchModel ? (
						// Empty-response circuit breaker tripped — N consecutive empty
						// replies from the same model. Open Settings so user can switch.
						<WarningBox
							className='text-sm my-1 mx-3'
							onClick={() => { commandService.executeCommand(VIBEIDE_OPEN_SETTINGS_ACTION_ID); }}
							text='Открыть настройки и выбрать другую модель'
						/>
					) : isRetry ? (
						// Hard-stall terminal error (no tokens within the watchdog window). Primary
						// recovery is re-sending the last turn WITHOUT a window reload; keep the
						// settings link as a secondary path (the message also suggests switching model).
						<>
							<WarningBox
								className='text-sm my-1 mx-3'
								onClick={() => { chatThreadsService.retryStalledStream(currentThread.id); }}
								text='Повторить запрос'
							/>
							<WarningBox
								className='text-sm my-1 mx-3'
								onClick={() => { chatThreadsService.retryStalledStreamWithDiagnostics(currentThread.id); }}
								text='Повторить с диагностикой'
							/>
							<WarningBox
								className='text-sm my-1 mx-3'
								onClick={() => { commandService.executeCommand('vibeide.chat.collectStallDiagnostics'); }}
								text='Собрать диагностику'
							/>
							<WarningBox
								className='text-sm my-1 mx-3'
								onClick={() => { commandService.executeCommand(VIBEIDE_OPEN_SETTINGS_ACTION_ID); }}
								text='Открыть настройки'
							/>
						</>
					) : (
						<>
							<p className="text-sm text-vibe-fg-3 px-1">Можно повторить попытку или сменить модель в настройках.</p>
							<WarningBox className='text-sm my-1 mx-3' onClick={() => { commandService.executeCommand(VIBEIDE_OPEN_SETTINGS_ACTION_ID); }} text='Открыть настройки' />
						</>
					)}
				</div>
			});
		}

		return items;
	}, [
		previousMessages,
		currCheckpointIdx,
		isRunning,
		threadId,
		scrollToBottomCallback,
		currStreamingMessageHTML,
		currThreadStreamState,
		generatingTool,
		displayContentSoFar,
		reasoningSoFar,
		latestError,
		chatThreadsService,
		commandService,
		currentThread.id,
	]);

	const messagesHTML = (
		<Virtuoso
			ref={virtuosoRef}
			// Force a full remount (and a fresh scroll position) when switching threads.
			key={'messages-' + chatThreadsState.currentThreadId}
			style={{ width: '100%', height: '100%' }}
			className={chatItems.length === 0 ? 'hidden' : ''}
			data={chatItems}
			computeItemKey={(_idx, item) => item.key}
			itemContent={(_idx, item) => (
				<div className='px-3 py-1.5'>
					{item.render()}
				</div>
			)}
			// Follow new content only when the user is already at the bottom. If they
			// scrolled up to read history, we won't yank them back to the bottom mid-read.
			followOutput={() => isAtBottomRef.current ? 'auto' : false}
			atBottomStateChange={handleAtBottomStateChange}
			// Treat "within 80px of the bottom" as at-bottom so streaming growth keeps auto-following
			// (a 0px threshold drops follow on the slightest lag) and the jump button hides near the end.
			atBottomThreshold={80}
			// On initial mount, open at the latest item so histories behave like a
			// normal chat (newest visible first).
			initialTopMostItemIndex={Math.max(0, chatItems.length - 1)}
			components={{ Scroller: ChatScroller }}
			// A small bottom buffer keeps the streaming bubble from popping in/out of
			// measurement while it grows.
			increaseViewportBy={{ top: 0, bottom: 400 }}
		/>
	);


	// ----- /skill: autocomplete ---------------------------------------------------
	// Drop-down that opens whenever the user types `/skill:` in the textarea. Lists
	// available skills sorted MRU-first (via vibeSkillsLibraryService.getRecentSkills),
	// filter-as-you-type, arrow/Tab/Enter to insert, Escape to dismiss. The trigger is
	// detected from text-before-cursor on every onChangeText; we re-derive open state
	// rather than tracking it imperatively so it always reflects current cursor context.
	type SkillCmd = { name: string; description: string; category: 'skill' };
	const [skillCmds, setSkillCmds] = useState<SkillCmd[]>([]);
	const [skillMenuOpen, setSkillMenuOpen] = useState(false);
	const [skillFilter, setSkillFilter] = useState('');
	const [skillIdx, setSkillIdx] = useState(0);
	// Anchor rect captured at trigger time. Stored as full top/bottom so we can pick
	// the dropdown side (above/below textarea) based on available viewport space.
	const [skillAnchorRect, setSkillAnchorRect] = useState<{ left: number; top: number; bottom: number; width: number } | null>(null);
	// Refs for keyboard scroll-into-view: array of item DIVs keyed by index.
	const skillItemRefs = useRef<Array<HTMLDivElement | null>>([]);

	// Fetch the skill list. Called on mount AND every time the `/skill:` menu opens — the skills
	// library scans `.vibe/skills/` lazily and can finish AFTER this component mounts (e.g. `.vibe`
	// defaults are seeded at workspace open), so a one-shot mount load left the dropdown PERMANENTLY
	// empty. Re-fetching when the trigger fires picks up late/changed skills; `getSkills()` is cached
	// and self-invalidates on `.vibe/skills/` file events, so this is cheap. Both services are guarded
	// — if either isn't registered the autocomplete stays empty rather than crashing the SidebarChat tree.
	const loadSkillCmds = useCallback(() => {
		const slashSvc = accessor.get('IVibeSlashCommandService');
		const skillsSvc = accessor.get('IVibeSkillsLibraryService');
		if (!slashSvc || !skillsSvc) {return;}
		slashSvc.getCommands().then(cmds => {
			const skills = cmds.filter((c): c is SkillCmd => c.category === 'skill');
			const recent = skillsSvc.getRecentSkills();
			const recentKeys = new Set(recent.map(id => `skill:${id}`));
			const recentList = recent
				.map(id => skills.find(s => s.name === `skill:${id}`))
				.filter((s): s is SkillCmd => !!s);
			const rest = skills
				.filter(s => !recentKeys.has(s.name))
				.sort((a, b) => a.name.localeCompare(b.name));
			const next = [...recentList, ...rest];
			// Avoid re-render churn: the menu re-fetches on every keystroke, so only update when the set changed.
			setSkillCmds(prev => (prev.length === next.length && prev.every((p, i) => p.name === next[i].name)) ? prev : next);
		}).catch(() => { /* skills service not ready or no skills — leave list empty */ });
	}, [accessor]);

	useEffect(() => { loadSkillCmds(); }, [loadSkillCmds]);

	// Keep the highlighted dropdown item visible when the user navigates with arrows.
	// Without this, ArrowDown past the visible window leaves the highlight off-screen.
	useEffect(() => {
		if (!skillMenuOpen) {return;}
		const el = skillItemRefs.current[skillIdx];
		el?.scrollIntoView({ block: 'nearest' });
	}, [skillIdx, skillMenuOpen]);

	// Filtered list shown in dropdown.
	const filteredSkillCmds = useMemo(() => {
		if (!skillFilter) {return skillCmds;}
		const q = skillFilter.toLowerCase();
		return skillCmds.filter(c => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q));
	}, [skillCmds, skillFilter]);

	// Insert the selected skill at the `/skill:` trigger position.
	const insertSelectedSkill = useCallback((cmd: SkillCmd) => {
		const ta = textAreaRef.current;
		if (!ta) {return;}
		const text = ta.value;
		const cursorPos = ta.selectionStart;
		const before = text.slice(0, cursorPos);
		const after = text.slice(cursorPos);
		const m = /\/skill:([\w.-]*)$/.exec(before);
		if (!m) {return;}
		const insertion = '/' + cmd.name + ' ';
		const newText = before.slice(0, m.index) + insertion + after;
		const newCursor = m.index + insertion.length;
		// Synthetic native setter so React picks up the change and onChange fires.
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
		setter?.call(ta, newText);
		ta.dispatchEvent(new Event('input', { bubbles: true }));
		ta.setSelectionRange(newCursor, newCursor);
		ta.focus();
		setSkillMenuOpen(false);
	}, []);

	const onChangeText = useCallback((newStr: string) => {
		setInstructionsAreEmpty(!newStr);
		// Persist the draft on every keystroke so switching chat tabs preserves unsent text.
		// (Saving on unmount is unreliable: with the per-thread key the composer unmounts before
		// the parent cleanup runs, and the rich input's value isn't on textAreaRef.value.)
		chatThreadsService.setThreadDraft(chatThreadsState.currentThreadId, newStr);
		// Detect `/skill:` trigger near cursor and open/close menu accordingly.
		const ta = textAreaRef.current;
		if (!ta) { setSkillMenuOpen(false); return; }
		const cursorPos = ta.selectionStart;
		const before = newStr.slice(0, cursorPos);
		const m = /\/skill:([\w.-]*)$/.exec(before);
		if (m) {
			loadSkillCmds(); // refresh on open so late-seeded/changed skills appear (cached → cheap)
			setSkillFilter(m[1]);
			setSkillIdx(0);
			setSkillMenuOpen(true);
			const rect = ta.getBoundingClientRect();
			setSkillAnchorRect({ left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width });
		} else {
			setSkillMenuOpen(false);
		}
	}, [setInstructionsAreEmpty, chatThreadsService, chatThreadsState.currentThreadId, loadSkillCmds]);

	const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
		// Skill menu takes precedence over Enter/Escape submit/abort when it's open.
		if (skillMenuOpen && filteredSkillCmds.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setSkillIdx(i => Math.min(filteredSkillCmds.length - 1, i + 1));
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setSkillIdx(i => Math.max(0, i - 1));
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				insertSelectedSkill(filteredSkillCmds[skillIdx]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				setSkillMenuOpen(false);
				return;
			}
		}
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			// Check isDisabled again at the time of key press (not closure value)
			if (!isDisabled && !isRunning) {
				onSubmit();
			} else if (isRunning) {
				// Agent is running → Enter queues the typed text as context for the NEXT hop (no abort).
				// See docs/knowledge/chat-ux/chat-interrupt-and-inject.md.
				e.preventDefault();
				onInject();
			}
		} else if (e.key === 'Escape' && isRunning) {
			onAbort();
		}
	}, [onSubmit, onAbort, onInject, isRunning, isDisabled, skillMenuOpen, filteredSkillCmds, skillIdx, insertSelectedSkill]);

	// Context usage calculation + warning (partially memoized - draft tokens calculated on each render)
	const [ctxWarned, setCtxWarned] = useState(false);
	const estimateTokens = useCallback((s: string) => Math.ceil((s || '').length / 4), []);
	const modelSel = settingsState.modelSelectionOfFeature['Chat'];

	// Provider-reported usage from the last finished assistant turn in this thread.
	// AI SDK exposes input/output/total via `finish` parts; chatThreadService persists
	// them on `state.lastUsage` in onFinalMessage. When present this is the authoritative
	// input-token count and replaces all heuristic paths.
	const lastUsage = currentThread?.state?.lastUsage;

	// Live "full prompt" estimate from IVibeContextGuardService.
	// `convertToLLMMessageService.prepareLLMChatMessages` calls `updateUsage(beforeTokens, contextWindow)`
	// where beforeTokens = approximateTotalTokens(messages, systemMessage, aiInstructions) —
	// i.e. the heuristic accounts for the FULL prompt (system + skill expansion + tools
	// schema + history), not just user/assistant content. That's why the right-side
	// "Контекст: X / Y" panel and the bottom status bar show realistic numbers while our
	// own previousMessages.reduce(length/4) under-counted by 10-50×. We subscribe to
	// onUsageUpdated so the chat-pane indicator stays in sync with the same source.
	const contextGuardService = accessor.get('IVibeContextGuardService');
	const [guardCurrentTokens, setGuardCurrentTokens] = useState(() => contextGuardService?.getStatus().currentTokens ?? 0);
	// D.9: learned estimate→real token-calibration factor, for the context-indicator tooltip.
	const [guardCalibration, setGuardCalibration] = useState<number | undefined>(() => contextGuardService?.getStatus().calibrationFactor);
	// Budget-fill transparency: kept-full vs summarized message counts from the last prompt build.
	const [guardTruncation, setGuardTruncation] = useState<{ kept?: number; summarized?: number }>(() => {
		const st = contextGuardService?.getStatus();
		return { kept: st?.keptMessages, summarized: st?.summarizedMessages };
	});
	useEffect(() => {
		if (!contextGuardService) {return;}
		const d = contextGuardService.onUsageUpdated(s => {
			setGuardCurrentTokens(s.currentTokens);
			setGuardTruncation({ kept: s.keptMessages, summarized: s.summarizedMessages });
			setGuardCalibration(s.calibrationFactor);
		});
		// Seed from current status in case an update fired before mount.
		const st = contextGuardService.getStatus();
		setGuardCurrentTokens(st.currentTokens ?? 0);
		setGuardTruncation({ kept: st.keptMessages, summarized: st.summarizedMessages });
		setGuardCalibration(st.calibrationFactor);
		return () => d.dispose();
	}, [contextGuardService]);

	// Memoize context budget and messages tokens (only recalculate when messages or model changes)
	const { contextBudget, messagesTokens } = useMemo(() => {
		let budget = 0;
		let tokens = 0;
		if (modelSel && isValidProviderModelSelection(modelSel)) {
			const { providerName, modelName } = modelSel;
			// Pull catalog hint (provider-reported contextWindow / supportsVision) so the
			// UI counter uses the same authoritative numbers as the request pipeline.
			const catalogSvc = accessor.get('IRemoteCatalogService');
			const catalogInfo = catalogSvc?.getCachedModelInfo(providerName, modelName);
			const caps = getModelCapabilities(providerName, modelName, settingsState.overridesOfModel, catalogInfo);
			const contextWindow = caps.contextWindow;
			const msOpts = settingsState.optionsOfModelSelection['Chat'][providerName]?.[modelName];
			const isReasoningEnabled2 = getIsReasoningEnabledState('Chat', providerName, modelName, msOpts, settingsState.overridesOfModel);
			const rot = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled: isReasoningEnabled2, overridesOfModel: settingsState.overridesOfModel }) || 0;
			budget = Math.max(256, Math.floor(contextWindow * 0.8) - rot);
			tokens = previousMessages.reduce((acc, m) => {
				if (m.role === 'user') {return acc + estimateTokens(m.content || '');}
				if (m.role === 'assistant') {return acc + estimateTokens((m.displayContent as string) || (m.content || '') || '');}
				return acc;
			}, 0);
		}
		return { contextBudget: budget, messagesTokens: tokens };
	}, [modelSel, previousMessages, settingsState.overridesOfModel, estimateTokens]);

	// Calculate draft tokens and total on each render (draft changes frequently)
	const draftTokens = estimateTokens(textAreaRef.current?.value || '');
	// Token count source priority (most accurate first):
	//   1. lastUsage from provider (real input+output for the previous turn).
	//   2. contextGuardService.currentTokens — heuristic but over the FULL prompt
	//      (matches the right-side "Контекст" panel and bottom status bar).
	//   3. messagesTokens — history-only heuristic (degenerate fallback before the
	//      first request is built).
	// Draft tokens are added on top via heuristic for live-update while typing.
	const realBaseTokens = (typeof lastUsage?.promptTokens === 'number' ? lastUsage.promptTokens : 0)
		+ (typeof lastUsage?.completionTokens === 'number' ? lastUsage.completionTokens : 0);
	const hasRealUsage = realBaseTokens > 0;
	const baseTokens = hasRealUsage ? realBaseTokens
		: (guardCurrentTokens > 0 ? guardCurrentTokens : messagesTokens);
	const contextTotal = baseTokens + draftTokens;
	const contextPct = contextBudget > 0 ? contextTotal / contextBudget : 0;

	useEffect(() => {
		if (contextPct > 0.8 && contextPct < 1 && !ctxWarned) {
			try { accessor.get('INotificationService').info(chatS.contextNearLimit(contextTotal, contextBudget)); } catch {}
			setCtxWarned(true);
		}
		if (contextPct < 0.6 && ctxWarned) {setCtxWarned(false);}
	}, [contextPct, ctxWarned, contextTotal, contextBudget, accessor]);

	// Pending-injection strip lives ABOVE the .relative input wrapper — otherwise the absolute
	// maximize/zen toolbar (anchored top/right of .relative) floats over the strip instead of the input.
	const pendingInjectionsStrip = pendingInjections.length > 0 ? (
		<div
			style={{
				margin: '0 6px 6px',
				padding: '6px 8px',
				borderRadius: '10px',
				background: 'rgba(234, 179, 8, 0.12)',
				border: '1px solid rgba(234, 179, 8, 0.35)',
				display: 'flex',
				flexDirection: 'column',
				gap: '4px',
			}}
		>
			<div className="text-xs" style={{ opacity: 0.8, display: 'flex', alignItems: 'center', gap: '6px' }}>
				<Pin size={12} />
				<span>В очереди — подмешается в следующем ходе агента ({pendingInjections.length})</span>
			</div>
			{pendingInjections.map((note, i) => (
				<div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
					<div
						className="text-xs text-vibe-fg-2"
						title={note}
						style={{
							flex: 1,
							minWidth: 0,
							whiteSpace: 'pre-wrap',
							overflow: 'hidden',
							display: '-webkit-box',
							WebkitLineClamp: 3,
							WebkitBoxOrient: 'vertical',
							opacity: 0.9,
						}}
					>
						{note}
					</div>
					<button
						type="button"
						onClick={() => chatThreadsService.removePendingInjection(threadId, i)}
						title="Убрать из очереди"
						aria-label="Убрать из очереди"
						style={{
							flexShrink: 0,
							padding: '2px',
							borderRadius: '4px',
							background: 'transparent',
							color: 'inherit',
							border: 'none',
							cursor: 'pointer',
							opacity: 0.6,
							display: 'flex',
						}}
						onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
						onMouseLeave={e => (e.currentTarget.style.opacity = '0.6')}
					>
						<X size={12} />
					</button>
				</div>
			))}
		</div>
	) : null;

	const inputChatArea = <>
		{pendingInjectionsStrip}
		<div className='relative'>
		<div
			style={{
				position: 'absolute',
				top: '6px',
				right: '6px',
				zIndex: 50,
				display: 'flex',
				alignItems: 'center',
				gap: '4px',
			}}
		>
			<button
				type='button'
				onClick={() => commandService.executeCommand('vibeide.chat.toggleMaximize')}
				title={chatS.maximizeChatTitle}
				aria-label={chatS.maximizeChatAria}
				style={{
					padding: '4px',
					borderRadius: '4px',
					background: 'transparent',
					color: 'inherit',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					border: 'none',
					cursor: 'pointer',
					opacity: 0.7,
				}}
				onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
				onMouseLeave={e => (e.currentTarget.style.opacity = '0.7')}
			>
				<Maximize2 size={14} />
			</button>
			<button
				type='button'
				onClick={() => commandService.executeCommand('vibeide.chat.toggleZen')}
				title={chatS.zenModeTitle}
				aria-label={chatS.zenModeAria}
				style={{
					padding: '4px',
					borderRadius: '4px',
					background: 'transparent',
					color: 'inherit',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					border: 'none',
					cursor: 'pointer',
					opacity: 0.7,
				}}
				onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
				onMouseLeave={e => (e.currentTarget.style.opacity = '0.7')}
			>
				<Maximize size={14} />
			</button>
		</div>
		<VibeChatArea
		featureName='Chat'
		onSubmit={() => onSubmit()}
		onContinue={(text) => onSubmit(text)}
		onAbort={onAbort}
		isStreaming={isActivelyStreaming}
		isDisabled={isDisabled}
		showSelections={true}
		// showProspectiveSelections={previousMessagesHTML.length === 0}
		selections={selections}
		setSelections={setSelections}
		onClickAnywhere={() => { textAreaRef.current?.focus(); }}
		imageAttachments={
			imageAttachments.length > 0 ? (
				<>
					<ImageAttachmentList
						attachments={imageAttachments}
						onRemove={removeImage}
						onRetry={retryImage}
						onCancel={cancelImage}
						focusedIndex={focusedImageIndex}
						onFocusChange={setFocusedImageIndex}
					/>
					{imageValidationError && (
						<div className="px-2 py-1 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-md mx-2">
							{imageValidationError.message}
						</div>
					)}
				</>
			) : null
		}
		onImageDrop={addImages}
		onPDFDrop={addPDFs}
		pdfAttachments={
			pdfAttachments.length > 0 ? (
				<>
					<PDFAttachmentList
						attachments={pdfAttachments}
						onRemove={removePDF}
						onRetry={retryPDF}
						onCancel={cancelPDF}
						focusedIndex={focusedPDFIndex}
						onFocusChange={setFocusedPDFIndex}
					/>
					{pdfValidationError && (
						<div className="px-2 py-1 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-md mx-2">
							{pdfValidationError}
						</div>
					)}
				</>
			) : null
		}
	>
		<VibeInputBox2
			enableAtToMention
			appearance="chatDark"
			className={`min-h-[60px] px-3 py-3 rounded-2xl`}
			placeholder={chatS.placeholderShort}
			onChangeText={onChangeText}
			onKeyDown={onKeyDown}
			onFocus={() => { chatThreadsService.setCurrentlyFocusedMessageIdx(undefined); }}
			ref={textAreaRef}
			fnsRef={textAreaFnsRef}
			multiline={true}
			highlightSlashCommands={true}
			onPasteFiles={(files) => {
				const images = files.filter(f => f.type.startsWith('image/'));
				const pdfs = files.filter(f => f.type === 'application/pdf');
				if (images.length > 0) {addImages(images);}
				if (pdfs.length > 0) {addPDFs(pdfs);}
			}}
		/>

		{/* /skill: autocomplete overlay — Cursor-style: section heading + 2-line items
		    (name + truncated sanitized description). Opens above the textarea by default,
		    flips below if more space is available there (e.g. chat pane docked near the
		    top of the window). */}
		{skillMenuOpen && skillAnchorRect && (() => {
			const GAP = 4;
			const MAX_DROPDOWN_H = 320;
			const spaceAbove = skillAnchorRect.top;
			const spaceBelow = window.innerHeight - skillAnchorRect.bottom;
			// Open upward if there's at least 160px above OR more space above than below.
			const openUpward = spaceAbove >= 160 || spaceAbove >= spaceBelow;
			const availableH = openUpward ? spaceAbove - GAP : spaceBelow - GAP;
			const dropdownH = Math.min(MAX_DROPDOWN_H, Math.max(140, availableH));
			const positionStyle: React.CSSProperties = openUpward
				? { bottom: window.innerHeight - skillAnchorRect.top + GAP }
				: { top: skillAnchorRect.bottom + GAP };
			const HEADER_H = 24;
			// Sanitize description: strip YAML folded-scalar markers (`>-`, `>+`, `>`,
			// `|-`, `|+`, `|`, `-` list bullet), collapse newlines and runs of whitespace,
			// trim, truncate. Without this we render literal YAML noise as the subtitle.
			const sanitizeDesc = (raw: string | undefined): string => {
				if (!raw) {return '';}
				let s = raw.replace(/^\s*[>|][+-]?\s*/g, '').replace(/\s+/g, ' ').trim();
				if (s.length > 120) {s = s.slice(0, 117) + '…';}
				return s;
			};
			return (
				<div
					className='fixed z-50 @@skill-menu-dropdown rounded-2xl shadow-xl overflow-hidden'
					style={{
						left: skillAnchorRect.left,
						width: Math.min(420, skillAnchorRect.width),
						maxHeight: dropdownH,
						...positionStyle,
					}}
					onMouseDown={(e) => { e.preventDefault(); /* keep textarea focus */ }}
				>
					<div className='px-3 py-1 text-[10px] uppercase tracking-wide text-vibe-fg-3 border-b border-vibe-border-1'>
						Skills:
					</div>
					<div className='overflow-y-auto' style={{ maxHeight: dropdownH - HEADER_H }}>
						{filteredSkillCmds.length === 0 && (
							<div className='px-3 py-2 text-vibe-fg-3 text-[12px]'>
								{skillCmds.length === 0
									? 'Скиллов нет — добавьте .vibe/skills/<id>/SKILL.md'
									: `Нет скиллов по фильтру «${skillFilter}»`}
							</div>
						)}
						{filteredSkillCmds.map((cmd, i) => {
							const desc = sanitizeDesc(cmd.description);
							return (
								<div
									key={cmd.name}
									ref={(el) => { skillItemRefs.current[i] = el; }}
									className='@@skill-menu-item px-3 py-1.5 cursor-pointer'
									data-active={i === skillIdx ? '' : undefined}
									onMouseEnter={() => setSkillIdx(i)}
									onClick={() => insertSelectedSkill(cmd)}
								>
									<div className='@@skill-menu-item-title text-vibe-fg-1 text-[13px] font-semibold truncate'>/{cmd.name}</div>
									{desc && <div className='text-vibe-fg-3 text-[11px] truncate mt-0.5'>{desc}</div>}
								</div>
							);
						})}
					</div>
				</div>
			);
		})()}

		{/* Context chips for current selections were rendered here as a SECOND copy of the
		    staging attachments (under the textarea, «Файл X ×» pills). Removed: the
		    SelectedFiles strip above the textarea is the single source — it supports
		    per-item removal and click-to-open, while this copy's × only popped the LAST
		    selection regardless of which chip was clicked. */}

	</VibeChatArea>
	</div>
	</>;


	const isLandingPage = previousMessages.length === 0;

	const initiallySuggestedPromptsHTML =					<div className='flex flex-col gap-2 w-full text-nowrap text-vibe-fg-3 select-none'>
		{[
			chatS.suggestSummarize,
			chatS.suggestRustTypes,
			chatS.suggestAgentsMd,
			chatS.suggestAgentRules,
		].map((text, index) => (
			<button
				type="button"
				key={index}
				className='@@vibe-pill-button @@vibe-focus-ring w-full text-left text-sm py-2 justify-start opacity-90 hover:opacity-100'
				onClick={() => onSubmit(text)}
			>
				{text}
			</button>
		))}
	</div>;



	const threadPageInput = <div key={'input' + chatThreadsState.currentThreadId}>
		<div className='px-4'>
			<CommandBarInChat />
		</div>
		<div className='px-2 pb-2'>
			{inputChatArea}

			{/* Context usage indicator */}
			{modelSel ? (
				(() => {
					const pctNum = Math.max(0, Math.min(100, Math.round(contextPct * 100)));
					const color = contextPct >= 1 ? 'text-red-500' : contextPct > 0.8 ? 'text-amber-500' : 'text-vibe-fg-3';
					const barColor = contextPct >= 1 ? 'bg-red-500' : contextPct > 0.8 ? 'bg-amber-500' : 'bg-vibe-fg-3/60';
					return <div className='mt-1'>
						<div title={guardCalibration && guardCalibration > 1 ? `Калибровка ×${guardCalibration.toFixed(2)}: показ контекста скорректирован под реальные токены провайдера (грубая оценка длина/4 их занижает)` : undefined} className={`text-[10px] ${color} flex items-center flex-wrap`}><span>{chatS.contextTokens(contextTotal, contextBudget, pctNum)}{hasRealUsage ? ` · last: ${lastUsage?.promptTokens ?? 0} in / ${lastUsage?.completionTokens ?? 0} out` : ''}{(guardTruncation.summarized ?? 0) > 0 ? chatS.budgetFillSuffix(guardTruncation.kept ?? 0, guardTruncation.summarized ?? 0) : ''}</span><TokenBudgetInline /></div>
						<div className='h-[3px] w-full bg-vibe-border-3 rounded mt-0.5'>
							<div className={`h-[3px] ${barColor} rounded`} style={{ width: `${pctNum}%` }} aria-label={chatS.contextUsageAria(pctNum)} />
						</div>
					</div>;
				})()
			) : null}
		</div>
	</div>;

	const landingPageInput = <div>
		<div className='pt-8'>
			{inputChatArea}
			{modelSel ? (
				(() => {
					const pctNum = Math.max(0, Math.min(100, Math.round(contextPct * 100)));
					const color = contextPct >= 1 ? 'text-red-500' : contextPct > 0.8 ? 'text-amber-500' : 'text-vibe-fg-3';
					const barColor = contextPct >= 1 ? 'bg-red-500' : contextPct > 0.8 ? 'bg-amber-500' : 'bg-vibe-fg-3/60';
					return <div className='mt-1 px-2'>
						<div title={guardCalibration && guardCalibration > 1 ? `Калибровка ×${guardCalibration.toFixed(2)}: показ контекста скорректирован под реальные токены провайдера (грубая оценка длина/4 их занижает)` : undefined} className={`text-[10px] ${color} flex items-center flex-wrap`}><span>{chatS.contextTokens(contextTotal, contextBudget, pctNum)}{hasRealUsage ? ` · last: ${lastUsage?.promptTokens ?? 0} in / ${lastUsage?.completionTokens ?? 0} out` : ''}{(guardTruncation.summarized ?? 0) > 0 ? chatS.budgetFillSuffix(guardTruncation.kept ?? 0, guardTruncation.summarized ?? 0) : ''}</span><TokenBudgetInline /></div>
						<div className='h-[3px] w-full bg-vibe-border-3 rounded mt-0.5'>
							<div className={`h-[3px] ${barColor} rounded`} style={{ width: `${pctNum}%` }} aria-label={chatS.contextUsageAria(pctNum)} />
						</div>
					</div>;
				})()
			) : null}
		</div>
	</div>;

    const keybindingService = accessor.get('IKeybindingService');
    const quickActions: { id: string; label: string }[] = [
        { id: 'vibe.explainCode', label: chatS.quickExplain },
        { id: 'vibe.refactorCode', label: chatS.quickRefactor },
        { id: 'vibe.addTests', label: chatS.quickAddTests },
        { id: 'vibe.fixTests', label: chatS.quickFixTests },
        { id: 'vibe.writeDocstring', label: chatS.quickDocstring },
        { id: 'vibe.optimizeCode', label: chatS.quickOptimize },
        { id: 'vibe.debugCode', label: chatS.quickDebug },
    ];

    const QuickActionsBar = () => (
        <div className='w-full flex items-center justify-center gap-2 flex-wrap mt-3 select-none px-1'>
            {quickActions.map(({ id, label }) => {
                const kb = keybindingService.lookupKeybinding(id)?.getLabel();
                return (
                    <button
                        key={id}
                        type="button"
                        className='@@vibe-pill-button @@vibe-focus-ring'
                        onClick={() => commandService.executeCommand(id)}
                        title={kb ? `${label} (${kb})` : label}
                    >
                        <span>{label}</span>
                        {kb && <span className='ml-1 px-1 rounded bg-[var(--vscode-keybindingLabel-background)] text-[var(--vscode-keybindingLabel-foreground)] border border-[var(--vscode-keybindingLabel-border)]'>{kb}</span>}
                    </button>
                );
            })}
        </div>
    );

    // Lightweight context chips: active file and model
    const ContextChipsBar = () => {
        const editorService = accessor.get('IEditorService');
        const activeEditor = editorService?.activeEditor;
        // Try best-effort file label
        const activeResource = activeEditor?.resource;
        const activeFileLabel = activeResource ? activeResource.path?.split('/').pop() : undefined;
        const modelSel = settingsState.modelSelectionOfFeature['Chat'];
        const modelLabel = modelSel ? `${displayInfoOfProviderName(modelSel.providerName).title}:${modelSel.modelName}` : undefined;
        if (!activeFileLabel && !modelLabel) {return null;}
        return (
            <div className='w-full flex items-center gap-2 flex-wrap mt-2 mb-1 px-1'>
                {activeFileLabel && (
                    <span className='inline-flex items-center gap-1 px-2 py-0.5 rounded-xl border border-vibe-border-3 bg-vibe-bg-1 text-vibe-fg-2 text-[11px]'>
                        <span>{chatS.chipFile}</span>
                        <span className='text-vibe-fg-1'>{activeFileLabel}</span>
                    </span>
                )}
                {modelLabel && (
                    <span className='inline-flex items-center gap-1 px-2 py-0.5 rounded-xl border border-vibe-border-3 bg-vibe-bg-1 text-vibe-fg-2 text-[11px]'>
                        <span>{chatS.chipModel}</span>
                        <span className='text-vibe-fg-1'>{modelLabel}</span>
                    </span>
                )}
            </div>
        );
    };

    const landingPageContent = <div
		ref={sidebarRef}
		className='@@vibe-chat-neon-scope @@vibe-chat-landing w-full h-full max-h-full flex flex-col overflow-auto px-3'
	>
		<ErrorBoundary>
			{landingPageInput}
		</ErrorBoundary>

		{/* Context chips */}
		<ErrorBoundary>
			<ContextChipsBar />
		</ErrorBoundary>

        {/* Quick Actions shortcuts */}
        <ErrorBoundary>
            <QuickActionsBar />
        </ErrorBoundary>

		{Object.keys(chatThreadsState.allThreads).length > 1 ? // show if there are threads
			<ErrorBoundary>
				<div className='pt-6 mb-2 text-vibe-fg-3 text-root select-none pointer-events-none'>{chatS.previousThreads}</div>
				<PastThreadsList />
			</ErrorBoundary>
			:
			<ErrorBoundary>
				<div className='pt-6 mb-2 text-vibe-fg-3 text-root select-none pointer-events-none'>{chatS.suggestions}</div>
				{initiallySuggestedPromptsHTML}
			</ErrorBoundary>
		}
	</div>;


	// const threadPageContent = <div>
	// 	{/* Thread content */}
	// 	<div className='flex flex-col overflow-hidden'>
	// 		<div className={`overflow-hidden ${previousMessages.length === 0 ? 'h-0 max-h-0 pb-2' : ''}`}>
	// 			<ErrorBoundary>
	// 				{messagesHTML}
	// 			</ErrorBoundary>
	// 		</div>
	// 		<ErrorBoundary>
	// 			{inputForm}
	// 		</ErrorBoundary>
	// 	</div>
	// </div>
	const threadPageContent = <div
		ref={sidebarRef}
		className='@@vibe-chat-neon-scope w-full h-full flex flex-col overflow-hidden'
	>

		<div className='relative flex-1 min-h-0'>
			<ErrorBoundary>
				{messagesHTML}
			</ErrorBoundary>
			{!atBottom && chatItems.length > 0 && (
				<button
					type='button'
					onClick={() => { isAtBottomRef.current = true; setAtBottom(true); scrollToBottomCallback(); }}
					title='Вниз, к последнему сообщению'
					aria-label='Прокрутить вниз'
					className='@@vibe-focus-ring'
					style={{
						position: 'absolute',
						bottom: '10px',
						right: '12px',
						zIndex: 30,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: '30px',
						height: '30px',
						borderRadius: '9999px',
						background: 'var(--vscode-button-secondaryBackground, rgba(40,40,40,0.9))',
						color: 'var(--vscode-button-secondaryForeground, #e0e0e0)',
						border: '1px solid rgba(255,255,255,0.12)',
						boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
						cursor: 'pointer',
						opacity: 0.92,
					}}
					onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
					onMouseLeave={e => (e.currentTarget.style.opacity = '0.92')}
				>
					<ChevronDown size={16} />
				</button>
			)}
		</div>
		<ErrorBoundary>
			{threadPageInput}
		</ErrorBoundary>
	</div>;


	return (
		<Fragment key={threadId} // force rerender when change thread
		>
			{isLandingPage ?
				landingPageContent
				: threadPageContent}
		</Fragment>
	);
};
