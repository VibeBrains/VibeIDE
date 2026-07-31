/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Context meter — the ring in the composer toolbar plus its detail popover.
 *
 * It replaces the two-line "Контекст ~N / M токенов" readout that used to sit under the
 * composer: a single always-visible ring for the at-a-glance number, everything else one click
 * away. Numbers come from the same services the bottom status bar reads
 * (`IVibeContextGuardService` / `IVibeTokenBudgetService`), so the ring and the status bar can
 * never disagree — the old readout computed its own budget and drifted from both.
 *
 * The component subscribes on its own rather than taking props: the toolbar renders inside
 * `VibeChatArea`, which is a different component from the one holding the chat's context state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { autoUpdate, flip, offset, shift, size, useFloating } from '@floating-ui/react';
import { useAccessor, useChatThreadsState, useSettingsState } from '../util/services.js';
import { isQuotaLow, tightestBucket } from '../../../../common/providerQuota.js';
import { chatS } from '../vibe-settings-tsx/vibeSettingsRu.js';
import type { TokenBudgetStatus } from '../../../../common/vibeTokenBudgetService.js';
import type { ContextLimitStatus } from '../../../vibeContextGuardService.js';
import type { ContextBreakdown } from '../../../convertToLLMMessageService.js';

const CONTEXT_REPORT_CMD = 'vibeide.context.status';
/** Opt-out for the ≥80% session-budget pulse (registered in `vibeTokenBudgetService`). */
const SESSION_WARN_BLINK_KEY = 'vibeide.safety.sessionTokenWarningBlink';

/** Same thresholds the status bar uses for its 🟢/🟡/🔴 marker. */
const WARN_PCT = 80;
const CRITICAL_PCT = 100;

const RING_SIZE = 18;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const formatTokens = (n: number): string => Math.max(0, Math.round(n)).toLocaleString('ru-RU');

/** Neutral track colour behind both the ring and the bars. */
// Fallback is not decoration: `--vscode-widget-border` is optional in a theme, and the VibeIDE
// default theme does not define it. Without the fallback the variable resolves to nothing,
// `stroke` collapses to `none`, and at 0% (where the progress arc is empty too) the ring
// disappears completely — the button stays clickable but invisible. Found by a live smoke.
const TRACK_COLOR = 'var(--vscode-widget-border, rgba(127, 127, 127, 0.35))';

/**
 * Fill colour for a percentage, as a theme token rather than a Tailwind class.
 *
 * Deliberate: `scope-tailwind` only rewrites class-name *literals* it can see in JSX, so utility
 * classes handed out by a helper never get the `vibe-` prefix, never match generated CSS, and
 * silently render unstyled (`stroke: none`). Theme tokens sidestep the prefixer entirely and
 * follow the same colour ramp as the status-bar 🟢/🟡/🔴 marker.
 */
// Fill ramp: blue while there is room, yellow near the limit, red at overflow — over a grey track.
//
// The yellow is a literal, not `--vscode-charts-yellow`, on purpose: in the VibeIDE theme every
// warning token (`charts-yellow`, `editorWarning-foreground`, `notificationsWarningIcon`) resolves
// to GREEN, so the "you are near the limit" step used to render as "all good". Verified live in a
// running IDE. Blue and red come from the theme, where the tokens are correct, with literals as a
// fallback for themes that leave them unset.
const RAMP_BLUE = 'var(--vscode-charts-blue, #59a4f9)';
const RAMP_YELLOW = '#e0af2b';
const RAMP_RED = 'var(--vscode-charts-red, #fe4450)';

const toneColorFor = (pct: number): string => {
	if (pct >= CRITICAL_PCT) {
		return RAMP_RED;
	}
	if (pct >= WARN_PCT) {
		return RAMP_YELLOW;
	}
	return RAMP_BLUE;
};

/** A labelled row with a thin fill bar, used for both the window and the session budget. */
const MeterRow = ({ label, value, pct, barColor }: { label: string; value: string; pct: number | null; barColor: string }) => (
	<div className='mb-2 last:mb-0'>
		<div className='flex items-baseline justify-between gap-2 text-[11px]'>
			<span className='text-vibe-fg-3'>{label}</span>
			<span className='text-vibe-fg-2 tabular-nums'>{value}</span>
		</div>
		{pct !== null ? (
			<div className='h-[3px] w-full rounded mt-1' style={{ backgroundColor: TRACK_COLOR }}>
				<div className='h-[3px] rounded' style={{ width: `${Math.max(0, Math.min(100, pct))}%`, backgroundColor: barColor }} />
			</div>
		) : null}
	</div>
);

export const ChatContextMeterButton = () => {
	const accessor = useAccessor();
	const contextGuard = accessor.get('IVibeContextGuardService');
	const budgetService = accessor.get('IVibeTokenBudgetService');
	const commandService = accessor.get('ICommandService');
	const convertService = accessor.get('IConvertToLLMMessageService');
	const configurationService = accessor.get('IConfigurationService');
	const settingsState = useSettingsState();
	const modelSel = settingsState.modelSelectionOfFeature['Chat'];

	// Passive quota tracking: the provider reports the key's remaining allowance on every
	// response, and chatThreadService stores the latest snapshot on the thread.
	const chatThreadsState = useChatThreadsState();
	const providerQuota = chatThreadsState.allThreads[chatThreadsState.currentThreadId]?.state?.lastProviderQuota;

	const [ctx, setCtx] = useState<ContextLimitStatus>(() => contextGuard.getStatus());
	const [budget, setBudget] = useState<TokenBudgetStatus>(() => budgetService.getStatus());
	const [isOpen, setIsOpen] = useState(false);
	const [breakdown, setBreakdown] = useState<ContextBreakdown | null>(null);
	const [breakdownLoading, setBreakdownLoading] = useState(false);
	const [blinkEnabled, setBlinkEnabled] = useState<boolean>(() => configurationService.getValue<boolean>(SESSION_WARN_BLINK_KEY) ?? true);

	useEffect(() => {
		const d1 = contextGuard.onUsageUpdated((s: ContextLimitStatus) => setCtx(s));
		const d2 = budgetService.onBudgetStatusChanged((s: TokenBudgetStatus) => setBudget(s));
		// Subscribe to the opt-out so toggling it takes effect immediately — even while idle at a
		// warning, when no budget change would otherwise re-render the ring.
		const d3 = configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SESSION_WARN_BLINK_KEY)) {
				setBlinkEnabled(configurationService.getValue<boolean>(SESSION_WARN_BLINK_KEY) ?? true);
			}
		});
		// Seed from current status in case an update fired before mount.
		setCtx(contextGuard.getStatus());
		setBudget(budgetService.getStatus());
		return () => { d1.dispose(); d2.dispose(); d3.dispose(); };
	}, [contextGuard, budgetService, configurationService]);

	// Breakdown is only worth computing while the popover is open — it walks the whole prompt.
	const breakdownRunId = useRef(0);
	useEffect(() => {
		if (!isOpen) {
			return;
		}
		const runId = ++breakdownRunId.current;
		setBreakdownLoading(true);
		convertService.buildContextBreakdown(modelSel ?? null)
			.then(result => { if (runId === breakdownRunId.current) { setBreakdown(result); } })
			.catch(() => { if (runId === breakdownRunId.current) { setBreakdown(null); } })
			.finally(() => { if (runId === breakdownRunId.current) { setBreakdownLoading(false); } });
	}, [isOpen, convertService, modelSel]);

	const { x, y, strategy, refs, update } = useFloating({
		open: isOpen,
		onOpenChange: setIsOpen,
		placement: 'top-start',
		middleware: [
			offset({ mainAxis: 6 }),
			flip({ boundary: document.body, padding: 8 }),
			shift({ boundary: document.body, padding: 8 }),
			size({
				apply({ availableHeight, elements }) {
					Object.assign(elements.floating.style, {
						maxHeight: `${Math.max(160, Math.min(availableHeight - 12, 420))}px`,
						overflowY: 'auto',
					});
				},
				padding: 8,
				boundary: document.body,
			}),
		],
		whileElementsMounted: autoUpdate,
		strategy: 'fixed',
	});

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		void update();
	}, [isOpen, update, breakdown]);

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Node;
			const floating = refs.floating.current;
			const reference = refs.reference.current;
			const isReferenceHTMLElement = reference && 'contains' in reference;
			if (floating && (!isReferenceHTMLElement || !reference.contains(target)) && !floating.contains(target)) {
				setIsOpen(false);
			}
		};
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setIsOpen(false);
			}
		};
		document.addEventListener('mousedown', handleClickOutside);
		document.addEventListener('keydown', handleEscape);
		return () => {
			document.removeEventListener('mousedown', handleClickOutside);
			document.removeEventListener('keydown', handleEscape);
		};
	}, [isOpen, refs.floating, refs.reference]);

	const openFullReport = useCallback(() => {
		setIsOpen(false);
		void commandService.executeCommand(CONTEXT_REPORT_CMD);
	}, [commandService]);

	const ctxKnown = ctx.maxTokens > 0;
	// Real percentage may exceed 100 when the calibration factor scales the estimate up — that is
	// a genuine overflow, so the number is reported as-is and only the ring is clamped.
	const rawPct = ctxKnown ? Math.max(0, Math.round(ctx.percentUsed)) : 0;
	const ringPct = Math.min(100, rawPct);
	const toneColor = toneColorFor(rawPct);
	const sessionEnabled = budget.sessionTokensLimit > 0;
	const sessionPct = sessionEnabled ? Math.max(0, Math.round(budget.percentUsed)) : null;
	// The ≥80% session-budget warning has no toast by design (only a log line), so the ring is its
	// only always-visible carrier: pulse it while inside the warning band (below 100%, where the
	// budget is merely close — at 100% the request is blocked or auto-reset and says so itself).
	// `isWarning` comes from the service so the threshold stays in one place.
	const sessionBlink = sessionEnabled && budget.isWarning && !budget.isExceeded && blinkEnabled;

	// What the PROVIDER still allows. Shown only when the tightest bucket has a limit to compare
	// against — a bare remainder cannot be drawn as a share, and inventing a denominator would
	// be exactly the guessing this feature exists to remove.
	const quotaRow = useMemo(() => {
		if (!providerQuota) { return null; }
		const now = Date.now();
		const bucket = tightestBucket(providerQuota);
		if (!bucket) { return null; }
		const kind = chatS.contextMeterQuotaKind(bucket.kind);
		const hasLimit = !!bucket.limit && bucket.limit > 0;
		const pct = hasLimit ? Math.max(0, Math.round((bucket.remaining / bucket.limit!) * 100)) : null;
		const resetsText = bucket.resetsAt && bucket.resetsAt > now
			? new Date(bucket.resetsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
			: null;
		return {
			// The bar shows what is LEFT, so a nearly empty quota reads as a nearly empty bar.
			pct,
			// …but the colour ramp speaks "how much is USED": passing the remainder straight into
			// toneColorFor would paint a full quota red and an exhausted one grey.
			usedPct: pct === null ? (bucket.remaining <= 0 ? 100 : 0) : 100 - pct,
			value: hasLimit
				? `${formatTokens(bucket.remaining)} / ${formatTokens(bucket.limit!)} ${kind} (${pct}%)`
				: `${formatTokens(bucket.remaining)} ${kind}`,
			isLow: isQuotaLow(providerQuota, now),
			resetsText,
		};
	}, [providerQuota]);

	const dashOffset = useMemo(
		() => RING_CIRCUMFERENCE * (1 - ringPct / 100),
		[ringPct],
	);

	return (
		<div className='inline-flex relative shrink-0'>
			{/* The pulse rides a wrapper rather than the button so the popover (a sibling below) never
			    blinks while open, and so the `@@` marker class stays a static JSX literal — it is
			    stripped only there, never inside a template interpolation (ui/scopeTailwind.md). */}
			<span className={sessionBlink ? 'inline-flex shrink-0 @@vibe-token-warn-blink' : 'inline-flex shrink-0'}>
				<button
					type='button'
					ref={refs.setReference}
					onClick={() => setIsOpen(v => !v)}
					className={`flex-shrink-0 p-1.5 rounded-xl transition-colors ${isOpen ? 'bg-vibe-bg-2-alt' : 'hover:bg-vibe-bg-2-alt'}`}
					style={{ color: toneColor }}
					aria-label={sessionBlink ? chatS.contextMeterSessionWarn(sessionPct ?? 0) : chatS.contextMeterAria(rawPct)}
					aria-expanded={isOpen}
					data-tooltip-id='vibe-tooltip'
					data-tooltip-content={sessionBlink
						? chatS.contextMeterSessionWarn(sessionPct ?? 0)
						: ctxKnown ? chatS.contextMeterTooltip(rawPct) : chatS.contextMeterUnknown}
					data-tooltip-place='top'
					data-tooltip-delay-show={1000}
				>
					<svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} className='block'>
						<circle
							cx={RING_SIZE / 2}
							cy={RING_SIZE / 2}
							r={RING_RADIUS}
							fill='none'
							strokeWidth={RING_STROKE}
							stroke={TRACK_COLOR}
						/>
						<circle
							cx={RING_SIZE / 2}
							cy={RING_SIZE / 2}
							r={RING_RADIUS}
							fill='none'
							strokeWidth={RING_STROKE}
							strokeLinecap='round'
							strokeDasharray={RING_CIRCUMFERENCE}
							strokeDashoffset={dashOffset}
							stroke={toneColor}
							transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
						/>
					</svg>
				</button>
			</span>

			{isOpen ? (
				<div
					ref={refs.setFloating}
					style={{ position: strategy, top: y ?? 0, left: x ?? 0, minWidth: '260px', maxWidth: 'min(90vw, 340px)' }}
					className='z-50 rounded-2xl shadow-xl bg-vibe-bg-1 border border-vibe-border-3 p-3 text-vibe-fg-2'
					role='dialog'
					aria-label={chatS.contextMeterTitle}
				>
					<div className='text-[11px] font-semibold text-vibe-fg-2 mb-2'>{chatS.contextMeterTitle}</div>

					{ctxKnown ? (
						<MeterRow
							label={chatS.contextMeterWindow}
							value={`${formatTokens(ctx.currentTokens)} / ${formatTokens(ctx.maxTokens)} (${rawPct}%)`}
							pct={ringPct}
							barColor={toneColor}
						/>
					) : (
						<div className='text-[11px] text-vibe-fg-3 mb-2'>{chatS.contextMeterUnknown}</div>
					)}

					<MeterRow
						label={chatS.contextMeterSession}
						value={sessionEnabled
							? `${formatTokens(budget.sessionTokensUsed)} / ${formatTokens(budget.sessionTokensLimit)} (${sessionPct}%)`
							: `${formatTokens(budget.sessionTokensUsed)} · ${chatS.contextMeterSessionNoLimit}`}
						pct={sessionPct}
						barColor={toneColorFor(sessionPct ?? 0)}
					/>

					{quotaRow ? (
						<MeterRow
							label={chatS.contextMeterProviderQuota}
							value={quotaRow.value}
							pct={quotaRow.pct}
							barColor={toneColorFor(quotaRow.usedPct)}
						/>
					) : null}
					{quotaRow?.isLow ? (
						<div className='text-[10px] mt-1' style={{ color: toneColorFor(CRITICAL_PCT) }}>{chatS.contextMeterQuotaLow}</div>
					) : null}
					{quotaRow?.resetsText ? (
						<div className='text-[10px] text-vibe-fg-4 mt-1'>{chatS.contextMeterQuotaResets(quotaRow.resetsText)}</div>
					) : null}

					{rawPct >= CRITICAL_PCT ? (
						<div className='text-[10px] mt-2' style={{ color: toneColorFor(CRITICAL_PCT) }}>{chatS.contextMeterOverflow(rawPct)}</div>
					) : null}
					{(ctx.summarizedMessages ?? 0) > 0 ? (
						<div className='text-[10px] text-vibe-fg-3 mt-1'>{chatS.contextMeterKeptSummarized(ctx.keptMessages ?? 0, ctx.summarizedMessages ?? 0)}</div>
					) : null}
					{ctx.calibrationFactor && ctx.calibrationFactor > 1 ? (
						<div className='text-[10px] text-vibe-fg-4 mt-1'>{chatS.contextMeterCalibration(ctx.calibrationFactor)}</div>
					) : null}

					<div className='mt-3 pt-2 border-t border-vibe-border-3'>
						<div className='text-[11px] text-vibe-fg-3 mb-1'>{chatS.contextMeterBreakdown}</div>
						{breakdownLoading && !breakdown ? (
							<div className='text-[10px] text-vibe-fg-4'>{chatS.contextMeterLoading}</div>
						) : breakdown && breakdown.segments.length > 0 ? (
							<div className='flex flex-col gap-0.5'>
								{breakdown.segments.filter(s => s.tokens > 0).map(segment => (
									<div key={segment.key} className='flex items-baseline justify-between gap-2 text-[10px]'>
										<span className='text-vibe-fg-3 truncate'>{segment.label}</span>
										<span className='text-vibe-fg-4 tabular-nums shrink-0'>{formatTokens(segment.tokens)}</span>
									</div>
								))}
								{typeof breakdown.messagesTokens === 'number' ? (
									<div className='flex items-baseline justify-between gap-2 text-[10px]'>
										<span className='text-vibe-fg-3 truncate'>История переписки</span>
										<span className='text-vibe-fg-4 tabular-nums shrink-0'>{formatTokens(breakdown.messagesTokens)}</span>
									</div>
								) : null}
							</div>
						) : (
							<div className='text-[10px] text-vibe-fg-4'>{chatS.contextMeterUnknown}</div>
						)}
					</div>

					<button
						type='button'
						onClick={openFullReport}
						className='mt-3 w-full text-[11px] rounded-xl py-1 bg-vibe-bg-2-alt hover:brightness-110 text-vibe-fg-2 transition-colors'
					>
						{chatS.contextMeterFullReport}
					</button>
				</div>
			) : null}
		</div>
	);
};
