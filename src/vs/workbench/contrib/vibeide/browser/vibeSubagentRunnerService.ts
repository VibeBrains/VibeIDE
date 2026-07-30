/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { RawToolCallObj, LLMChatMessage, LLMTokenUsage } from '../common/sendLLMMessageTypes.js';
import { vibeLog } from '../common/vibeLog.js';
import { ModelSelection } from '../common/vibeideSettingsTypes.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { isModelVisionCapable } from '../common/modelVisionHeuristics.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { BuiltinToolName, ToolName } from '../common/toolsServiceTypes.js';
import { approvalTypeOfBuiltinToolName } from '../common/prompt/tools/index.js';
import { truncateHeadTail } from '../common/toolHardening.js';
import { IVibeSubagentRunner, SubagentRunRequest, SubagentRunOutcome } from '../common/vibeSubagentRunner.js';
import { IVibeSubagentRegistryService } from '../common/vibeSubagentRegistryService.js';
import { IVibeSpendLedgerService } from './vibeSpendLedgerService.js';
import { decideStop, hopTokenCost, truncateSummary, chatModeForAllowedTools, collectPathsFromRawParams, buildExploreReport, buildSubagentTaskMessage, stopReasonToRussian, SUBAGENT_MAX_DENIED_ACTIONS, SubagentStopReason } from '../common/subagentLoopPolicy.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { IToolsService } from './toolsService.js';
import { IVibeAgentActivityLogService } from './vibeAgentActivityLogService.js';

/** Under Autopilot, resource limits auto-extend rather than stop the role. This cooldown backstops a
 *  pathological tight loop (instant hops) from resetting the budget hundreds of times per second —
 *  mirrors vibeTokenBudgetService's AUTOPILOT_RESET_COOLDOWN_MS. */
const SUBAGENT_AUTOPILOT_RESET_COOLDOWN_MS = 1_000;

/** Consecutive per-hop LLM errors (provider/network/timeout blips) tolerated before the role hard-fails.
 *  A transient error must not kill an otherwise-healthy run — the main agent retries too. Under Autopilot
 *  the budget is larger (unattended completion). Counter resets on any successful hop. */
const SUBAGENT_MAX_LLM_RETRIES = 4;
const SUBAGENT_MAX_LLM_RETRIES_AUTOPILOT = 12;

/** The compact-handoff contract: no result field exceeds this. */
const MAX_SUMMARY_CHARS = 500;
/**
 * Tool results are head+tail-truncated BEFORE entering the loop's history (audit I): the
 * history is re-sent on every hop, so one big read_file would inflate every later hop and
 * eat the (now honest) token quota. The model still sees both ends of the output.
 */
const SUBAGENT_TOOL_RESULT_MAX_CHARS = 16_000;
/** Tools whose successful calls count as produced artifacts. */
const WRITE_TOOL_NAMES = new Set(['edit_file', 'rewrite_file', 'create_file_or_folder']);

type HopOutcome =
	| { kind: 'final'; fullText: string; toolCall: RawToolCallObj | undefined; usage: LLMTokenUsage | undefined }
	| { kind: 'error'; message: string };

/**
 * Headless subagent tool-loop (Phase 3b) — the real executor behind `vibeSubagentService`.
 *
 * Isolation per roadmap § I.0: the loop runs over its OWN in-memory `ChatMessage[]`
 * transcript (never the thread store) with its own step/time/token budgets. Tools are
 * enforced twice: prompt-side via ChatMode ('gather' hides every approval tool from
 * read-only roles) and runtime-side via the role whitelist (a non-whitelisted call is
 * answered with a corrective tool error, not executed). Approval-requiring tools of
 * full roles go through an explicit user confirm — the runner never silently writes.
 */
class VibeSubagentRunnerService extends Disposable implements IVibeSubagentRunner {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILLMMessageService private readonly _llm: ILLMMessageService,
		@IConvertToLLMMessageService private readonly _convert: IConvertToLLMMessageService,
		@IToolsService private readonly _tools: IToolsService,
		@IVibeideSettingsService private readonly _settings: IVibeideSettingsService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notification: INotificationService,
		@IVibeAgentActivityLogService private readonly _activityLog: IVibeAgentActivityLogService,
		@IVibeSubagentRegistryService private readonly _registry: IVibeSubagentRegistryService,
		@IVibeSpendLedgerService private readonly _spendLedger: IVibeSpendLedgerService,
	) {
		super();
	}

	async run(req: SubagentRunRequest): Promise<SubagentRunOutcome> {
		const preset = this._registry.getPreset(req.type);
		// Model priority (VA.2 «модель на роль»): explicit request → per-role mapping from
		// settings → the session's Chat model. Read-only roles are the cost-routing case:
		// a light model plans/reviews fine while the Chat model does the heavy lifting.
		let modelSelection = req.modelSelection
			?? this._settings.state.modelSelectionOfRole?.[req.type]
			?? this._settings.state.modelSelectionOfFeature?.['Chat'];
		if (!modelSelection || modelSelection.providerName === 'auto') {
			return this._outcome(req, 'failed', 'Не выбрана модель для субагента (настройте модель чата).', [], 0, false, 'нет модели', []);
		}

		// Vision routing model resolution. `sees` = can this selection accept image input; `firstVision`
		// = the first enabled vision-capable model. Shared by звено 4 (default) and звено 3 (guarantee)
		// so the two never drift; the decision itself lives in common/modelVisionHeuristics.ts.
		const overridesOfModel = this._settings.state.overridesOfModel;
		const sees = (sel: ModelSelection) => sel.providerName !== 'auto'
			&& isModelVisionCapable(sel, getModelCapabilities(sel.providerName, sel.modelName, overridesOfModel));
		const firstVision = (): ModelSelection | undefined => this._settings.state._modelOptions.find(o => sees(o.selection))?.selection;

		// Звено 4: the vision-sink role (designer) defaults to a vision-capable model when the user
		// left its per-role model unset and the chat fallback can't see — so it is vision-ready by
		// default, before any image arrives. An explicit per-role pick is always respected.
		const explicitRoleModel = req.modelSelection ?? this._settings.state.modelSelectionOfRole?.[req.type];
		if (!explicitRoleModel && preset.receivesImages && !sees(modelSelection)) {
			const v = firstVision();
			if (v) { modelSelection = v; }
		}

		// Звено 3: an actually-attached image MUST reach a vision model — overrides even an explicit
		// pick, since silently feeding an image to a blind model yields hallucinated descriptions.
		if (req.images && req.images.length && !sees(modelSelection)) {
			const v = firstVision();
			if (v) {
				this._notification.info(localize('subagent.visionFallback', "Роль «{0}»: приложено изображение, но модель {1} его не видит — для этого прогона взята vision-модель {2}.", preset.displayName, modelSelection.modelName, v.modelName));
				modelSelection = v;
			} else {
				this._notification.warn(localize('subagent.visionNone', "Роль «{0}» получила изображение, но ни одна включённая модель не поддерживает vision — картинка будет проигнорирована. Настройте vision-модель.", preset.displayName));
			}
		}

		const chatMode = chatModeForAllowedTools(req.allowedTools);
		const deadlineAtMs = req.maxWallClockMs > 0 ? Date.now() + req.maxWallClockMs : 0;
		// Mutable: under Autopilot the resource limits are SOFT — they auto-extend instead of stopping
		// the role (see the reset block in the loop). cancelled/denied-actions stay hard.
		let limits = { maxSteps: req.maxSteps, maxTokensEst: req.maxTokensEst, deadlineAtMs, maxDeniedActions: SUBAGENT_MAX_DENIED_ACTIONS };

		const taskMessage = buildSubagentTaskMessage({ displayName: preset.displayName, systemAppendix: preset.systemAppendix, goal: req.goal, acceptanceCriteria: req.acceptanceCriteria, contextItems: req.contextItems });
		const history: ChatMessage[] = [{
			role: 'user',
			content: taskMessage,
			displayContent: taskMessage,
			selections: null,
			// Vision routing (звено 2): images ride the first user message. prepareLLMChatMessages
			// base64-encodes them into image parts exactly as for the main thread — no new plumbing.
			...(req.images && req.images.length ? { images: [...req.images] } : {}),
			state: { stagingSelections: [], isBeingEdited: false },
		}];

		let stepsDone = 0;
		let deniedActions = 0;
		let consecutiveLlmErrors = 0;
		// Counted per hop below: the dominant cost of an agent loop is INPUT — the whole
		// history is re-sent on every hop (audit E: output-only counting made the quota fictional).
		let tokensUsedEst = 0;
		// Raw provider-reported sums (incl. cached reads) — for cost display, not for the quota.
		let promptTokensUsed = 0;
		let completionTokensUsed = 0;
		let cachedTokensUsed = 0;
		let lastText = '';
		const artifacts: string[] = [];
		const touchedPaths: string[] = [];

		this._activityLog.logStarted(`Subagent ${req.type} (${req.subagentId}): ${chatMode}-режим, шагов ≤${req.maxSteps}, модель ${modelSelection.providerName}/${modelSelection.modelName}`);

		// Autopilot inheritance: the user opted into unattended completion, so a subagent must NOT
		// introduce a NEW stop point. Resource limits (steps/time/tokens) auto-extend instead of
		// parking the role — mirroring the main agent's session-budget auto-reset (vibeTokenBudgetService).
		// A short cooldown backstops a pathological tight loop (instant hops). cancelled/denied-actions
		// remain hard stops (user intent / safety). Read fresh each iteration: toggling Autopilot OFF
		// mid-run re-arms the limits so the user can rein in a runaway role.
		let lastAutoResetAt = 0;

		while (true) {
			const autopilot = this._settings.state.globalSettings.chatAgentAutopilot === true;
			const stop = decideStop({ stepsDone, tokensUsedEst, deniedActions, nowMs: Date.now(), cancelled: req.cancellationToken?.isCancellationRequested === true }, limits);
			if (stop && autopilot && (stop === 'max-steps' || stop === 'deadline' || stop === 'token-budget')) {
				const now = Date.now();
				if (now - lastAutoResetAt >= SUBAGENT_AUTOPILOT_RESET_COOLDOWN_MS) {
					lastAutoResetAt = now;
					if (stop === 'max-steps') { limits = { ...limits, maxSteps: limits.maxSteps + req.maxSteps }; }
					else if (stop === 'deadline') { limits = { ...limits, deadlineAtMs: limits.deadlineAtMs + req.maxWallClockMs }; }
					else { limits = { ...limits, maxTokensEst: limits.maxTokensEst + req.maxTokensEst }; }
					this._activityLog.logStarted(`Subagent ${req.subagentId}: автопилот — авто-сброс лимита «${stopReasonToRussian(stop)}», продолжаю`);
					continue;
				}
				// Inside cooldown: fall through and stop (prevents a tight infinite reset loop).
			}
			if (stop) {
				const reason = stopReasonToRussian(stop);
				const modelLabel = `${modelSelection.providerName}/${modelSelection.modelName}`;
				this._activityLog.logError(`Subagent ${req.subagentId}: остановлен — ${reason} (${modelLabel})`);
				// Cancellation is the USER's explicit decision — a hard stop, never a resume bait
				// (auto-resuming a cancelled subagent would restart it against the user's will).
				if (stop === 'cancelled') {
					return this._outcome(req, 'failed', `Роль «${preset.displayName}»: ${reason}.`, artifacts, tokensUsedEst, true, reason, touchedPaths, { stopCode: stop, model: modelSelection, promptTokens: promptTokensUsed, completionTokens: completionTokensUsed, cachedTokens: cachedTokensUsed });
				}
				// token-budget is VibeIDE's OWN per-subagent cap, not the provider's quota — say so
				// and show the numbers, so «исчерпана квота» isn't misread as a provider limit.
				const budgetNote = stop === 'token-budget'
					? ` (лимит VibeIDE на субагента, не квота провайдера: ~${tokensUsedEst}/${limits.maxTokensEst} токенов)`
					: '';
				// Soft degradation: NOT a hard failure. Keep the partial result (lastText + artifacts +
				// touched paths) and return status 'stopped' so the route/report shows partial work that
				// can be resumed, instead of discarding it as «failed».
				const summary = `Роль «${preset.displayName}» остановлена: ${reason}${budgetNote}. Модель ${modelLabel}. Частичный результат сохранён. Последний вывод: ${lastText}`;
				return this._outcome(req, 'stopped', summary, artifacts, tokensUsedEst, true, reason, touchedPaths, { stopCode: stop, model: modelSelection, promptTokens: promptTokensUsed, completionTokens: completionTokensUsed, cachedTokens: cachedTokensUsed });
			}
			stepsDone++;

			const { messages, separateSystemMessage } = await this._convert.prepareLLMChatMessages({
				chatMessages: history,
				chatMode,
				modelSelection,
				// Do not clobber the parent thread's context meter with this role's prompt size.
				skipContextGuardUpdate: true,
			});
			const hop = await this._sendOnce({ req, messages, separateSystemMessage, chatMode, modelSelection, deadlineAtMs: limits.deadlineAtMs });
			if (hop.kind === 'error') {
				// A deadline firing MID-REQUEST aborts the stream and surfaces here as an error. Use the
				// CURRENT (possibly auto-extended) deadline, not the stale original — otherwise an extended
				// run would still trip at the first deadline.
				const deadlineHit = limits.deadlineAtMs > 0 && Date.now() >= limits.deadlineAtMs && req.cancellationToken?.isCancellationRequested !== true;
				if (deadlineHit) {
					// Under Autopilot the wall-clock is soft — same as the between-hops reset: extend and
					// retry the hop instead of stopping the role (the failed hop does not consume a step).
					if (autopilot && Date.now() - lastAutoResetAt >= SUBAGENT_AUTOPILOT_RESET_COOLDOWN_MS) {
						lastAutoResetAt = Date.now();
						limits = { ...limits, deadlineAtMs: limits.deadlineAtMs + req.maxWallClockMs };
						this._activityLog.logStarted(`Subagent ${req.subagentId}: автопилот — авто-сброс лимита «${stopReasonToRussian('deadline')}» (в момент запроса), продолжаю`);
						stepsDone = Math.max(0, stepsDone - 1);
						continue;
					}
					const reason = stopReasonToRussian('deadline');
					this._activityLog.logError(`Subagent ${req.subagentId}: остановлен — ${reason} (в момент запроса к модели)`);
					const summary = `Роль «${preset.displayName}» остановлена: ${reason}. Частичный результат сохранён. Последний вывод: ${lastText}`;
					return this._outcome(req, 'stopped', summary, artifacts, tokensUsedEst, true, reason, touchedPaths, { stopCode: 'deadline', model: modelSelection, promptTokens: promptTokensUsed, completionTokens: completionTokensUsed, cachedTokens: cachedTokensUsed });
				}
				// Transient LLM error (provider 5xx, rate-limit, network, timeout): retry the hop with a
				// short backoff instead of hard-failing — a blip must not kill a healthy run. Autopilot
				// gets a larger budget (unattended). The failed hop does NOT consume a step. Give up only
				// after too many CONSECUTIVE errors (reset on any success below).
				consecutiveLlmErrors++;
				const llmRetryBudget = autopilot ? SUBAGENT_MAX_LLM_RETRIES_AUTOPILOT : SUBAGENT_MAX_LLM_RETRIES;
				if (consecutiveLlmErrors <= llmRetryBudget && req.cancellationToken?.isCancellationRequested !== true) {
					this._activityLog.logStarted(`Subagent ${req.subagentId}: ошибка запроса «${hop.message}» — повтор ${consecutiveLlmErrors}/${llmRetryBudget}`);
					stepsDone = Math.max(0, stepsDone - 1);
					await new Promise(resolve => setTimeout(resolve, Math.min(8_000, 1_500 * consecutiveLlmErrors)));
					continue;
				}
				this._activityLog.logError(`Subagent ${req.subagentId}: ошибка LLM — ${hop.message}`);
				const shortMsg = hop.message.length > 140 ? `${hop.message.slice(0, 140)}…` : hop.message;
				return this._outcome(req, 'failed', `Роль «${preset.displayName}»: ошибка запроса к модели — ${hop.message}`, artifacts, tokensUsedEst, false, `ошибка модели: ${shortMsg}`, touchedPaths, { model: modelSelection, promptTokens: promptTokensUsed, completionTokens: completionTokensUsed, cachedTokens: cachedTokensUsed });
			}

			consecutiveLlmErrors = 0; // healthy hop — clear the transient-error streak

			// Charge this hop by the provider's real usage (uncached input + output); the char
			// count of the re-sent messages is only a fallback when usage is absent. Prompt-cached
			// history is excluded, so a role is not billed again for context it already paid for —
			// this is what keeps later hops from exhausting the quota. Tool results are not charged
			// here: they enter the next hop's prompt tokens and are counted there.
			tokensUsedEst += hopTokenCost(hop.usage, JSON.stringify(messages).length + (separateSystemMessage?.length ?? 0) + hop.fullText.length);
			promptTokensUsed += hop.usage?.promptTokens ?? 0;
			completionTokensUsed += hop.usage?.completionTokens ?? 0;
			cachedTokensUsed += hop.usage?.cachedInputTokens ?? 0;
			// Money spent by a role is money spent: without this the «Ключи и расход» panel showed
			// only the main agent's exchanges and quietly under-reported every route of roles.
			this._recordSpend(modelSelection, hop.usage);
			req.onProgress?.(tokensUsedEst, stepsDone, limits.deadlineAtMs);
			lastText = hop.fullText || lastText;
			const toolCall = hop.toolCall;

			// Natural completion: prose without a tool call, or an explicit vibe_complete.
			if (!toolCall || toolCall.name.toLowerCase() === 'vibe_complete') {
				const completeSummary = toolCall
					? String(toolCall.rawParams['summary'] ?? toolCall.rawParams['result'] ?? lastText)
					: lastText;
				this._activityLog.logFinished(`Subagent ${req.subagentId}: завершено за ${stepsDone} шаг(ов), ~${tokensUsedEst} ток. (оценка)`);
				return this._outcome(req, 'success', completeSummary || `Роль «${preset.displayName}» завершила задачу.`, artifacts, tokensUsedEst, false, 'completed', touchedPaths, { model: modelSelection, promptTokens: promptTokensUsed, completionTokens: completionTokensUsed, cachedTokens: cachedTokensUsed });
			}

			// From here on the model asked for a real tool — append its assistant turn first.
			history.push({ role: 'assistant', displayContent: hop.fullText, reasoning: '', anthropicReasoning: null });

			const isBuiltin = Object.hasOwn(this._tools.validateParams, toolCall.name);
			const isAllowed = isBuiltin && req.allowedTools.includes(toolCall.name);
			if (!isAllowed) {
				deniedActions++;
				history.push(this._invalidToolMessage(toolCall, `Инструмент «${toolCall.name}» не разрешён роли «${preset.displayName}». Доступные инструменты: ${req.allowedTools.join(', ')}. Используй только их.`));
				continue;
			}
			// Safe cast: builtin-ness just verified via the validateParams map itself.
			const toolName = toolCall.name as BuiltinToolName;

			let params: unknown;
			try {
				params = this._tools.validateParams[toolName](toolCall.rawParams as never);
			} catch (e) {
				deniedActions++;
				history.push(this._invalidToolMessage(toolCall, `Некорректные параметры «${toolName}»: ${e instanceof Error ? e.message : String(e)}`));
				continue;
			}

			// Approval gate: the runner bypasses the chat-thread approval flow, so approval-requiring
			// tools (writes/terminal) get an explicit user confirm here — UNLESS the parent's own
			// auto-approve gates already opt in. We mirror chatThreadService exactly (constraints are
			// INHERITED from the parent, never weakened AND never strengthened): autopilot approves
			// everything; otherwise the per-type `autoApprove` opt-in applies. So under autopilot a
			// role runs tools without asking, same as the main agent.
			const approvalType = approvalTypeOfBuiltinToolName[toolName];
			if (approvalType) {
				const gs = this._settings.state.globalSettings;
				const autoApproved = gs.chatAgentAutopilot === true || gs.autoApprove[approvalType] === true;
				if (!autoApproved) {
					const { confirmed } = await this._dialogService.confirm({
						message: localize('vibeide.subagentRunner.approve', "Субагент-роль «{0}» запрашивает инструмент «{1}»", preset.displayName, toolName),
						detail: localize('vibeide.subagentRunner.approveDetail', "Параметры: {0}", truncateSummary(JSON.stringify(toolCall.rawParams), 300)),
						primaryButton: localize('vibeide.subagentRunner.approveBtn', "Разрешить"),
					});
					if (!confirmed) {
						deniedActions++;
						// eslint-disable-next-line local/code-no-dangerous-type-assertions -- internal ToolMessage builder widened to the ChatMessage union; tool params are loosely typed
						history.push({
							role: 'tool', type: 'rejected', result: null,
							name: toolName as ToolName, params: params as never,
							content: 'Пользователь отклонил вызов инструмента. Предложи другой путь или заверши задачу.',
							id: toolCall.id || generateUuid(), rawParams: toolCall.rawParams, mcpServerName: undefined,
						} as ChatMessage);
						continue;
					}
				}
			}

			try {
				const { result } = await this._tools.callTool[toolName](params as never);
				deniedActions = 0; // a tool ran cleanly — the «stuck» guard counts CONSECUTIVE misfires, not lifetime
				const content = truncateHeadTail(this._tools.stringOfResult[toolName](params as never, result as never), SUBAGENT_TOOL_RESULT_MAX_CHARS);
				const paths = collectPathsFromRawParams(toolCall.rawParams);
				touchedPaths.push(...paths);
				if (WRITE_TOOL_NAMES.has(toolName)) { artifacts.push(...paths); }
				// Not charged here — this result is re-sent as input on the next hop and counted
				// via that hop's prompt tokens (avoids double-counting with hopTokenCost).
				// eslint-disable-next-line local/code-no-dangerous-type-assertions -- internal ToolMessage builder widened to the ChatMessage union; tool params are loosely typed
				history.push({
					role: 'tool', type: 'success', result: result as never,
					name: toolName as ToolName, params: params as never,
					content,
					id: toolCall.id || generateUuid(), rawParams: toolCall.rawParams, mcpServerName: undefined,
				} as ChatMessage);
			} catch (e) {
				const errText = e instanceof Error ? e.message : String(e);
				// eslint-disable-next-line local/code-no-dangerous-type-assertions -- internal ToolMessage builder widened to the ChatMessage union; tool params are loosely typed
				history.push({
					role: 'tool', type: 'tool_error', result: errText,
					name: toolName as ToolName, params: params as never,
					content: errText,
					id: toolCall.id || generateUuid(), rawParams: toolCall.rawParams, mcpServerName: undefined,
				} as ChatMessage);
			}
		}
	}

	private _sendOnce(opts: {
		req: SubagentRunRequest;
		messages: LLMChatMessage[];
		separateSystemMessage: string | undefined;
		chatMode: 'agent' | 'gather';
		modelSelection: ModelSelection;
		deadlineAtMs: number;
	}): Promise<HopOutcome> {
		return new Promise<HopOutcome>(resolve => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			// eslint-disable-next-line prefer-const -- captured by `finish` (below) before the deferred assignment; `const` would hit the TDZ
			let cancelSub: { dispose(): void } | undefined;
			const finish = (v: HopOutcome) => {
				if (settled) { return; }
				settled = true;
				if (timer !== undefined) { clearTimeout(timer); }
				cancelSub?.dispose();
				resolve(v);
			};
			const requestId = this._llm.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: opts.messages,
				separateSystemMessage: opts.separateSystemMessage,
				chatMode: opts.chatMode,
				modelSelection: opts.modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel: this._settings.state.overridesOfModel,
				onText: () => { },
				onFinalMessage: p => finish({ kind: 'final', fullText: p.fullText, toolCall: p.toolCall, usage: p.usage }),
				onError: e => finish({ kind: 'error', message: e.message || String(e) }),
				onAbort: () => finish({ kind: 'error', message: 'запрос прерван (отмена или лимит времени субагента)' }),
				// Subagents have their own quota + per-role accounting — keep their spend out of the
				// main-agent session budget (both the pre-send gate and the usage counter).
				excludeFromSessionBudget: true,
				logging: { loggingName: `Subagent/${opts.req.type}` },
			});
			if (requestId === null) { return; } // onError has already fired synchronously
			if (opts.deadlineAtMs > 0) {
				const remainingMs = Math.max(1_000, opts.deadlineAtMs - Date.now());
				timer = setTimeout(() => this._llm.abort(requestId), remainingMs);
			}
			// Audit A: parent cancellation kills the IN-FLIGHT request too, not just the next
			// hop — otherwise a disposed subagent still finishes (and pays for) this hop.
			cancelSub = opts.req.cancellationToken?.onCancellationRequested(() => this._llm.abort(requestId));
		});
	}

	private _invalidToolMessage(toolCall: RawToolCallObj, content: string): ChatMessage {
		// eslint-disable-next-line local/code-no-dangerous-type-assertions -- internal ToolMessage builder widened to the ChatMessage union
		return {
			role: 'tool', type: 'invalid_params', result: null,
			name: toolCall.name,
			content,
			id: toolCall.id || generateUuid(), rawParams: toolCall.rawParams, mcpServerName: undefined,
		} as ChatMessage;
	}

	/**
	 * Fold one role hop into the spend ledger, priced by the model the role actually ran on.
	 * Fire-and-forget and never fatal: a missing price must not interrupt the role, and an
	 * unknown price is recorded as unknown rather than as free (see `spendLedger`).
	 */
	private _recordSpend(model: ModelSelection | undefined, usage: LLMTokenUsage | undefined): void {
		if (!model || !usage || (!usage.promptTokens && !usage.completionTokens)) {
			return;
		}
		void (async () => {
			try {
				const { getModelCapabilities } = await import('../common/modelCapabilities.js');
				const capabilities = getModelCapabilities(model.providerName, model.modelName, this._settings.state.overridesOfModel);
				this._spendLedger.record({
					providerId: model.providerName,
					modelId: model.modelName,
					inputTokens: usage.promptTokens ?? 0,
					outputTokens: usage.completionTokens ?? 0,
					cachedInputTokens: usage.cachedInputTokens ?? 0,
					price: capabilities.cost,
				});
			} catch (err) {
				vibeLog.warn('subagentRunner', `расход роли не записан: ${err}`);
			}
		})();
	}

	private _outcome(req: SubagentRunRequest, status: 'success' | 'failed' | 'stopped', summary: string, artifacts: string[], tokensUsedEst: number, truncated: boolean, stopReason: string, touchedPaths: string[], extra?: { stopCode?: SubagentStopReason; model?: ModelSelection; promptTokens?: number; completionTokens?: number; cachedTokens?: number }): SubagentRunOutcome {
		return {
			status,
			summary: truncateSummary(summary, MAX_SUMMARY_CHARS),
			artifacts: [...new Set(artifacts)],
			tokensUsedEst,
			truncated,
			stopReason,
			...(extra?.stopCode ? { stopCode: extra.stopCode } : {}),
			...(extra?.model && extra.model.providerName !== 'auto' ? { providerName: extra.model.providerName, modelName: extra.model.modelName } : {}),
			...(extra?.promptTokens ? { promptTokensUsed: extra.promptTokens } : {}),
			...(extra?.completionTokens ? { completionTokensUsed: extra.completionTokens } : {}),
			...(extra?.cachedTokens ? { cachedTokensUsed: extra.cachedTokens } : {}),
			...(req.type === 'explore' ? { exploreReport: buildExploreReport(touchedPaths, truncated) } : {}),
		};
	}
}

registerSingleton(IVibeSubagentRunner, VibeSubagentRunnerService, InstantiationType.Delayed);
