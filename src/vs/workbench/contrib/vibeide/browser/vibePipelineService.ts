/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pipeline runner — steps executed in order, each picking up what the previous one produced.
 *
 * The parts already existed separately: roles gate the tools, budgets cap the spend, the ledger
 * records the run, and a subagent already returns `{summary, artifacts}`. This service is only the
 * line connecting them, and it keeps no judgement of its own — what to hand over and when to stop
 * live in `common/pipeline/vibePipelineFile.ts`, where they can be tested without spawning agents.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { safeParseConfigJson } from '../common/vibeConfigJsonParser.js';
import { IVibeHooksService } from '../common/hooks/vibeHookTypes.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IChatThreadService } from './chatThreadService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isSubagentType, IVibeSubagentService, SUBAGENT_TYPES, SubagentType } from '../common/vibeSubagentService.js';
import { ProviderId } from '../common/vibeideSettingsTypes.js';
import { vibeLog } from '../common/vibeLog.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';
import {
	buildStepInput,
	composeReviewGoal,
	parseModelRef,
	parsePipelineFile,
	parseReviewVerdict,
	PipelineStepOutcome,
	shouldRunStep,
	VibePipeline,
	VibePipelineStep,
} from '../common/pipeline/vibePipelineFile.js';

const CONFIG_REVIEWER_SEES_SUMMARY = 'vibeide.pipeline.reviewerSeesStepSummary';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	title: localize('vibeide.pipeline.configTitle', "VibeIDE — пайплайны"),
	type: 'object',
	properties: {
		[CONFIG_REVIEWER_SEES_SUMMARY]: {
			type: 'boolean',
			default: false,
			description: localize('vibeide.pipeline.reviewerSeesStepSummary', "Показывать ревьюеру шага пересказ исполнителя. По умолчанию выключено: ревьюер получает задачу шага, критерий готовности и файлы и проверяет по ним, а не по словам «всё сделано». Включается для сравнения режимов: у каждого вердикта в логе и в результате прогона отмечено, видел ли ревьюер пересказ."),
		},
	},
});

export interface PipelineRunResult {
	readonly pipelineId: string;
	readonly outcomes: readonly PipelineStepOutcome[];
	/** True when every step that ran succeeded and none was skipped by a failure. */
	readonly completed: boolean;
}

export interface PipelineProgress {
	readonly pipelineId: string;
	readonly stepIndex: number;
	readonly totalSteps: number;
	readonly role: string;
	readonly state: 'started' | 'finished' | 'skipped';
}

export const IVibePipelineService = createDecorator<IVibePipelineService>('vibePipelineService');

export interface IVibePipelineService {
	readonly _serviceBrand: undefined;
	readonly onProgress: Event<PipelineProgress>;
	/** Pipelines declared in `.vibe/pipelines.json`, plus any warnings worth showing the user. */
	list(): Promise<{ pipelines: readonly VibePipeline[]; warnings: readonly string[] }>;
	/** Run one pipeline to the end (or to the first failure). */
	run(pipelineId: string, parentThreadId: string, token?: CancellationToken): Promise<PipelineRunResult>;
}

export class VibePipelineService extends Disposable implements IVibePipelineService {
	declare readonly _serviceBrand: undefined;

	private readonly _onProgress = this._register(new Emitter<PipelineProgress>());
	readonly onProgress: Event<PipelineProgress> = this._onProgress.event;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IVibeSubagentService private readonly _subagents: IVibeSubagentService,
		@IVibeHooksService private readonly _hooks: IVibeHooksService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
	}

	private _fileUri(): URI | undefined {
		const folders = this._workspace.getWorkspace().folders;
		return folders.length > 0 ? joinPath(folders[0].uri, '.vibe', 'pipelines.json') : undefined;
	}

	async list(): Promise<{ pipelines: readonly VibePipeline[]; warnings: readonly string[] }> {
		const uri = this._fileUri();
		if (!uri) { return { pipelines: [], warnings: [] }; }
		let text: string;
		try {
			text = (await this._fileService.readFile(uri)).value.toString();
		} catch {
			// No file is the ordinary case, not an error worth reporting.
			return { pipelines: [], warnings: [] };
		}
		// JSONC, not JSON: the seeded file documents each step in a comment beside it, and a strict
		// parser would reject the seed on its first line.
		const result = safeParseConfigJson(text);
		if (!result.ok) {
			return { pipelines: [], warnings: [localize('vibeide.pipeline.badJson', '.vibe/pipelines.json — не разобрать JSON: {0}', result.reason)] };
		}
		const parsed = parsePipelineFile(result.value);
		return { pipelines: parsed.file.pipelines, warnings: parsed.warnings };
	}

	/**
	 * Ask a second model whether the step's result stands.
	 *
	 * The reviewer is a `reviewer` role — read-only by construction, so a critique cannot quietly
	 * become a second implementation. It is told to end with a verdict word, because the pipeline has
	 * to act on the answer and prose cannot be acted on; an answer without one is reported as
	 * «вердикт не распознан» rather than guessed in either direction.
	 *
	 * It is told what the step was asked to do, not what the worker says it did — `composeReviewGoal`
	 * has the reasoning. The setting that brings the worker's account back exists to compare the two,
	 * so the mode is logged next to every verdict and kept in the outcome.
	 */
	private async _review(step: VibePipelineStep, result: { summary: string; artifacts?: readonly string[] }, parentThreadId: string): Promise<PipelineStepOutcome['review']> {
		const reviewer = parseModelRef(step.reviewWith);
		if (!reviewer) {
			return undefined;
		}
		const worker = parseModelRef(step.model);
		if (worker && worker.providerName === reviewer.providerName) {
			// Not refused — the provider is a weak proxy for the model family, and one provider does
			// serve several families. Said out loud because a critique by a sibling model is the case
			// where the whole exercise quietly stops working.
			vibeLog.warn('Pipeline', `шаг ${step.role}: ревьюер и исполнитель у одного провайдера (${reviewer.providerName}) — критика своего же семейства`);
		}
		const sawWorkerSummary = this._configuration.getValue<boolean>(CONFIG_REVIEWER_SEES_SUMMARY) === true;
		const goal = composeReviewGoal(step, result.summary, sawWorkerSummary);
		const reviewerId = await this._subagents.spawn({
			parentThreadId,
			// `code-reviewer` is read-only by construction — a critique cannot quietly become a second
			// implementation, which is the failure mode of «let another model fix it».
			type: 'code-reviewer',
			goal,
			...(result.artifacts && result.artifacts.length > 0 ? { contextItems: [...result.artifacts] } : {}),
			modelSelection: { providerName: reviewer.providerName as ProviderId, modelName: reviewer.modelName },
		});
		const verdictResult = await this._subagents.awaitResult(reviewerId);
		this._subagents.disposeSubagent(reviewerId);
		const verdict = parseReviewVerdict(verdictResult.summary);
		vibeLog.info('Pipeline', `шаг ${step.role}: ревью ${step.reviewWith} — ${verdict}, пересказ исполнителя ${sawWorkerSummary ? 'показан' : 'скрыт'}`);
		return { by: step.reviewWith!, verdict, notes: verdictResult.summary, sawWorkerSummary };
	}

	async run(pipelineId: string, parentThreadId: string, token?: CancellationToken): Promise<PipelineRunResult> {
		const { pipelines } = await this.list();
		const pipeline = pipelines.find(p => p.id === pipelineId);
		if (!pipeline) {
			throw new Error(localize('vibeide.pipeline.notFound', 'Пайплайн «{0}» не найден в .vibe/pipelines.json', pipelineId));
		}

		const outcomes: PipelineStepOutcome[] = [];
		// NOT registered on the service: `run` is called repeatedly, and a source registered per
		// call would accumulate for the lifetime of the window. It is disposed in `finally` below.
		const cancellation = new CancellationTokenSource(token);
		try {
			for (let i = 0; i < pipeline.steps.length; i++) {
				const step = pipeline.steps[i];
				if (cancellation.token.isCancellationRequested) { break; }
				if (!shouldRunStep(step, outcomes)) {
					// Recorded rather than dropped: a reader of the result must see WHY the tail did
					// not run, otherwise a stopped pipeline looks like a shorter pipeline.
					outcomes.push({ role: step.role, status: 'skipped', summary: localize('vibeide.pipeline.skipped', 'Пропущен: предыдущий шаг не удался'), artifacts: [] });
					this._onProgress.fire({ pipelineId, stepIndex: i, totalSteps: pipeline.steps.length, role: step.role, state: 'skipped' });
					continue;
				}

				this._onProgress.fire({ pipelineId, stepIndex: i, totalSteps: pipeline.steps.length, role: step.role, state: 'started' });
				const input = buildStepInput(step, outcomes);
				try {
					// An unknown role must fail loudly here. Cast into the union and the subagent would
					// look up a tool whitelist that does not exist — an agent with no tools, silently
					// producing prose instead of work.
					if (!isSubagentType(step.role)) {
						throw new Error(localize('vibeide.pipeline.badRole', 'Неизвестная роль «{0}». Доступны: {1}', step.role, SUBAGENT_TYPES.join(', ')));
					}
					const runStep = async (modelRef: string | undefined, cascadeDraft: boolean, escalatedFrom?: { runId: string; model?: string }, reviewNotes?: string) => {
						const model = parseModelRef(modelRef);
						const subagentId = await this._subagents.spawn({
							parentThreadId,
							type: step.role as SubagentType,
							goal: reviewNotes ? `${input.goal}\n\nЗАМЕЧАНИЯ РЕВЬЮЕРА (устраните их):\n${reviewNotes}` : input.goal,
							...(step.acceptance ? { acceptanceCriteria: step.acceptance } : {}),
							...(input.contextItems.length > 0 ? { contextItems: [...input.contextItems] } : {}),
							...(step.maxTokens !== undefined ? { maxTokens: step.maxTokens } : {}),
							...(step.maxSteps !== undefined ? { maxSteps: step.maxSteps } : {}),
							...(model ? { modelSelection: { providerName: model.providerName as ProviderId, modelName: model.modelName } } : {}),
							// Границы записи шага — независимо от роли: роль решает «пишет ли вообще»,
							// это решает «пишет ли СЮДА».
							...(step.paths || step.denyPaths ? {
								writeScope: {
									...(step.paths ? { paths: step.paths } : {}),
									...(step.denyPaths ? { denyPaths: step.denyPaths } : {}),
								},
							} : {}),
							...(cascadeDraft ? { cascadeDraft: true } : {}),
							...(escalatedFrom ? { escalatedFrom } : {}),
						});
						const result = await this._subagents.awaitResult(subagentId);
						this._subagents.disposeSubagent(subagentId);
						return { subagentId, result };
					};

					// Cascade: the cheap model drafts, and the step's own outcome is the gate. Asking a
					// model whether its answer was good enough gets an answer shaped like «yes», so the
					// gate is the run's verdict — the acceptance check and the tools that ran it.
					const drafting = step.escalateTo !== undefined;
					const first = await runStep(step.model, drafting);
					let result = first.result;
					let escalated = false;
					// A project-owned gate on top of the step's own outcome: a draft can succeed and
					// still be too thin to keep. Exit 2 from a `pipelineStepEnd` hook rejects it, which
					// is a deterministic answer to a question a model cannot be trusted with about its
					// own work. No hook, hooks off, or a broken script — the outcome decides as before.
					let rejectedByGate: string | undefined;
					if (drafting && result.status === 'success' && !cancellation.token.isCancellationRequested) {
						const gate = await this._hooks.run('pipelineStepEnd', {
							pipeline: pipelineId,
							step: i + 1,
							role: step.role,
							model: step.model,
							answer: result.summary,
						});
						if (gate.blocked) {
							rejectedByGate = gate.agentMessage;
							vibeLog.info('Pipeline', `${pipelineId} шаг ${i + 1}: гейт приёмки отклонил черновик`);
						}
					}
					if (drafting && (result.status !== 'success' || rejectedByGate !== undefined) && !cancellation.token.isCancellationRequested) {
						vibeLog.info('Pipeline', `${pipelineId} шаг ${i + 1}: ${rejectedByGate ? 'гейт отклонил черновик' : 'черновик не прошёл'}, эскалация на ${step.escalateTo}`);
						this._onProgress.fire({ pipelineId, stepIndex: i, totalSteps: pipeline.steps.length, role: step.role, state: 'started' });
						// The draft's model is named only when the step named it: an empty string would look
						// like a model in the report, and «ran on the role's default» is the honest answer.
						const second = await runStep(step.escalateTo, false, { runId: first.subagentId, ...(step.model ? { model: step.model } : {}) });
						result = second.result;
						escalated = true;
					}
					// Critique: a second model reads the result and says whether it stands. Only after a
					// successful run — reviewing a step that failed tells the user what they already
					// know, and costs a model call to say it.
					let review: PipelineStepOutcome['review'];
					if (step.reviewWith && result.status === 'success' && !cancellation.token.isCancellationRequested) {
						review = await this._review(step, result, parentThreadId);
						if (review?.verdict === 'rework') {
							vibeLog.info('Pipeline', `${pipelineId} шаг ${i + 1}: ревьюер требует доработки, переделываю один раз`);
							this._onProgress.fire({ pipelineId, stepIndex: i, totalSteps: pipeline.steps.length, role: step.role, state: 'started' });
							// One revision, not a loop: two models disagreeing can trade opinions forever,
							// and the user is paying per exchange. The verdict travels with the outcome, so
							// a result that stayed unconvincing is visible rather than retried in silence.
							const revised = await runStep(escalated ? step.escalateTo : step.model, false, undefined, review.notes);
							result = revised.result;
						}
					}
					outcomes.push({
						role: step.role,
						status: result.status,
						summary: result.summary,
						artifacts: result.artifacts ?? [],
						...(escalated ? { escalatedTo: step.escalateTo } : {}),
						...(review ? { review } : {}),
					});
				} catch (err) {
					// A step that could not even start is a failed step, not a crashed pipeline: the
					// outcomes collected so far are the user's answer to "what did it manage to do".
					vibeLog.error('Pipeline', `${pipelineId} шаг ${i + 1} (${step.role}): ${err}`);
					outcomes.push({
						role: step.role,
						status: 'failed',
						summary: err instanceof Error ? err.message : String(err),
						artifacts: [],
					});
				}
				this._onProgress.fire({ pipelineId, stepIndex: i, totalSteps: pipeline.steps.length, role: step.role, state: 'finished' });
			}
		} finally {
			cancellation.dispose();
		}

		return {
			pipelineId,
			outcomes,
			completed: outcomes.length > 0 && outcomes.every(o => o.status === 'success'),
		};
	}
}

registerSingleton(IVibePipelineService, VibePipelineService, InstantiationType.Delayed);

registerAction2(class VibeRunPipeline extends Action2 {
	constructor() {
		super({
			id: 'vibeide.pipeline.run',
			title: localize2('vibeide.pipeline.run', 'Запустить пайплайн'),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const pipelineService = accessor.get(IVibePipelineService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const chatThreads = accessor.get(IChatThreadService);

		const { pipelines, warnings } = await pipelineService.list();
		// Warnings are shown BEFORE the picker: a user hunting for a pipeline that is missing from
		// the list needs to know it was skipped over a typo, not silently absent.
		for (const warning of warnings) {
			notifications.notify({ severity: Severity.Warning, message: warning });
		}
		if (pipelines.length === 0) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.pipeline.none', 'В `.vibe/pipelines.json` нет ни одного пайплайна. Формат — docs/manuals/pipelinesSpec.md.'),
			});
			return;
		}

		const picked = await quickInput.pick(
			pipelines.map(p => ({
				label: p.name ?? p.id,
				description: `${p.steps.length} шага(ов): ${p.steps.map(s => s.role).join(' → ')}`,
				detail: p.description,
				id: p.id,
			})),
			{ placeHolder: localize('vibeide.pipeline.pick', 'Какой пайплайн запустить?') },
		);
		if (!picked?.id) { return; }

		const parentThreadId = chatThreads.getCurrentThread().id;
		try {
			const result = await pipelineService.run(picked.id, parentThreadId);
			const failed = result.outcomes.filter(o => o.status !== 'success');
			notifications.notify({
				severity: failed.length === 0 ? Severity.Info : Severity.Warning,
				message: failed.length === 0
					? localize('vibeide.pipeline.done', 'Пайплайн «{0}» прошёл целиком: {1} шага(ов).', picked.id, result.outcomes.length)
					: localize('vibeide.pipeline.partial', 'Пайплайн «{0}»: удалось {1} из {2}. Первая заминка — шаг «{3}»: {4}',
						picked.id, result.outcomes.length - failed.length, result.outcomes.length, failed[0].role, failed[0].summary),
			});
		} catch (err) {
			notifications.notify({ severity: Severity.Error, message: String(err instanceof Error ? err.message : err) });
		}
	}
});
