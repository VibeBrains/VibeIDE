/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pipeline runner — steps executed in order, each picking up what the previous one produced; the steps
 * of a wave start together, and the next step waits for the last of them.
 *
 * The parts already existed separately: roles gate the tools, budgets cap the spend, the ledger
 * records the run, and a subagent already returns `{summary, artifacts}`. This service is only the
 * line connecting them, and it keeps no judgement of its own — what to hand over, when to stop, what
 * may run at once and who is shown the diff live in `common/pipeline/`, where they can be tested
 * without spawning agents.
 */

import { IntervalTimer, Sequencer } from '../../../../base/common/async.js';
import { toAction } from '../../../../base/common/actions.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { safeParseConfigJson } from '../common/vibeConfigJsonParser.js';
import { IVibeHooksService } from '../common/hooks/vibeHookTypes.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IChatThreadService } from './chatThreadService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isSubagentType, IVibeSubagentService, roleMayWrite, SUBAGENT_TYPES, SubagentHandoff, SubagentResult, SubagentType } from '../common/vibeSubagentService.js';
import { ProviderId } from '../common/vibeideSettingsTypes.js';
import { vibeLog } from '../common/vibeLog.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';
import {
	buildStepInput,
	composeReviewGoal,
	composeReworkRequest,
	effectiveWriteScope,
	parseModelRef,
	parsePipelineFile,
	parseReviewVerdict,
	pipelineStepLabel,
	PipelineStepOutcome,
	QA_DEFAULT_WRITE_PATHS,
	shouldRunStep,
	VibePipeline,
	VibePipelineStep,
} from '../common/pipeline/vibePipelineFile.js';
import { applyWaveRules, pipelineGroups, StepGroup } from '../common/pipeline/pipelineWaves.js';
import { composeDiffBlock, receivesRunDiff, runDiffBudgetChars, wantsRunDiff } from '../common/pipeline/pipelineRunDiff.js';
import { readRolesFile } from '../common/pipeline/vibeRolesFile.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { nextOffPeakMoment } from '../common/modelPriceSchedule.js';
import { resolveModelReference } from '../common/modelRouteKeys.js';
import { IVibeDynamicProvidersService } from './vibeDynamicProvidersService.js';
import { CollectedDiff, IVibeRunDiffService } from '../common/vibeideSCMTypes.js';
import { IVibeVerifyGateService } from './vibeVerifyGateService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { resolveRuntimeStatePath } from '../common/vibeRuntimeStateLocation.js';
import { compactPipelineRunJournal, parsePipelineRunJournal, pipelineShapeOf, PipelineRunRecord, ResumableRun, resumableRunOf, serializePipelineRun } from '../common/pipeline/pipelineRunJournal.js';

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
	readonly state: 'started' | 'finished' | 'skipped' | 'waiting';
	/** For `waiting`: when the step starts on its own — the end of its model's price peak. */
	readonly until?: number;
	/** The wave the step belongs to, when it runs beside other steps. */
	readonly wave?: string;
}

export const IVibePipelineService = createDecorator<IVibePipelineService>('vibePipelineService');

export interface IVibePipelineService {
	readonly _serviceBrand: undefined;
	readonly onProgress: Event<PipelineProgress>;
	/** Pipelines declared in `.vibe/pipelines.json`, plus any warnings worth showing the user. */
	list(): Promise<{ pipelines: readonly VibePipeline[]; warnings: readonly string[] }>;
	/**
	 * The interrupted run of this pipeline a person may continue — «Стоп», a failed step, or a window that closed mid-run —
	 * or `undefined` when the latest run finished, nothing of it finished, or the pipeline's steps changed since
	 */
	interruptedRun(pipelineId: string): Promise<ResumableRun | undefined>;
	/**
	 * Run one pipeline to the end (or to the first failure). Cancelling the token stops every step under way.
	 * `resume` — continue that interrupted run: its finished steps are not run again, their outcomes go to the steps after them
	 */
	run(pipelineId: string, parentThreadId: string, token?: CancellationToken, resume?: { readonly runId: string }): Promise<PipelineRunResult>;
}

/** The journal of pipeline runs, beside the agents' own in `.vibe/local` */
const PIPELINE_JOURNAL_FILE = 'pipeline-runs.jsonl';
/** A live run signs its record this often; three missed beats mean its window is gone, not busy — the agents' ledger cadence */
const PIPELINE_HEARTBEAT_MS = 30_000;
const PIPELINE_STALE_AFTER_MS = 3 * PIPELINE_HEARTBEAT_MS;
/** Kept in the journal: the newest runs within a month, as the agents' ledger keeps */
const PIPELINE_JOURNAL_MAX_RECORDS = 200;
const PIPELINE_JOURNAL_RETENTION_DAYS = 30;

/** What every step of one run shares. */
interface PipelineRunContext {
	readonly pipelineId: string;
	readonly parentThreadId: string;
	/** Names the run's snapshots in git. */
	readonly runId: string;
	readonly totalSteps: number;
	/** The `qa` write boundary, read once for the whole run. */
	readonly qaWritePaths: readonly string[];
	readonly token: CancellationToken;
	/** Cancel the whole run from inside a step — «Отменить прогон» of an off-peak wait. */
	readonly cancel: () => void;
	/** Runs under way — «Стоп» disposes each of them, a wave's included. */
	readonly live: Set<string>;
	/** Verify checks, one at a time: two builds in one folder write the same output and break each other. */
	readonly verify: Sequencer;
	/** The snapshot every judge's diff is measured from; `undefined` when nothing needed it or git could not pin it. */
	readonly baseline: string | undefined;
	/** Whether anything was pinned — then the run's pins are released at its end. */
	pinned: boolean;
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
		@IVibeideSettingsService private readonly _settings: IVibeideSettingsService,
		@INotificationService private readonly _notifications: INotificationService,
		@IVibeRunDiffService private readonly _runDiff: IVibeRunDiffService,
		@IVibeVerifyGateService private readonly _verifyGate: IVibeVerifyGateService,
		@IVibeDynamicProvidersService private readonly _dynamicProviders: IVibeDynamicProvidersService,
	) {
		super();
	}

	/** This window's mark on the runs it owns: a `running` record of another window gone quiet is an interrupted run */
	private readonly _epoch = generateUuid();
	/** Journal writes one at a time: two runs of one window must not read the same file and each drop the other's line */
	private readonly _journalWrites = new Sequencer();

	private async _journalPath(): Promise<URI | undefined> {
		return resolveRuntimeStatePath(this._fileService, this._workspace.getWorkspace().folders[0]?.uri, PIPELINE_JOURNAL_FILE);
	}

	private async _readJournal(path: URI): Promise<PipelineRunRecord[]> {
		try {
			return parsePipelineRunJournal((await this._fileService.readFile(path)).value.toString());
		} catch {
			return [];
		}
	}

	/** Put the run's latest state in the journal; a failed write is logged, never a reason to stop the run */
	private _recordRun(record: PipelineRunRecord): Promise<void> {
		return this._journalWrites.queue(async () => {
			const path = await this._journalPath();
			if (!path) {
				return;
			}
			try {
				const others = (await this._readJournal(path)).filter(r => r.runId !== record.runId);
				const kept = compactPipelineRunJournal([...others, record], Date.now(), PIPELINE_JOURNAL_MAX_RECORDS, PIPELINE_JOURNAL_RETENTION_DAYS);
				await this._fileService.writeFile(path, VSBuffer.fromString(kept.map(serializePipelineRun).join('')), { atomic: { postfix: '.vibe-tmp' } });
			} catch (err) {
				vibeLog.warn('Pipeline', `журнал прогонов не записан: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	async interruptedRun(pipelineId: string): Promise<ResumableRun | undefined> {
		const pipeline = (await this.list()).pipelines.find(p => p.id === pipelineId);
		const path = pipeline ? await this._journalPath() : undefined;
		return pipeline && path ? resumableRunOf(await this._readJournal(path), pipeline, this._epoch, Date.now(), PIPELINE_STALE_AFTER_MS) : undefined;
	}

	/**
	 * Hold an `offPeak` step until its model leaves the price peak.
	 *
	 * Visible and skippable on purpose: a run that silently stops for hours looks hung. The wait ends by
	 * itself at the off-peak moment, by «Запустить сейчас», or by cancelling the run. A model without a
	 * price by the hour starts at once and says why — the field cannot defer to a schedule nobody declared.
	 */
	private async _waitForOffPeak(step: VibePipelineStep, pipelineId: string, stepIndex: number, totalSteps: number, token: CancellationToken): Promise<'run' | 'cancelled'> {
		const model = parseModelRef(step.model);
		if (!model) {
			return 'run';
		}
		const schedule = getModelCapabilities(model.providerName as ProviderId, model.modelName, this._settings.state.overridesOfModel).cost?.time_of_day;
		if (!schedule) {
			vibeLog.warn('Pipeline', `шаг ${step.role}: offPeak, но у ${step.model} нет цены по часу — шаг запускается сразу`);
			return 'run';
		}
		const now = Date.now();
		const until = nextOffPeakMoment(schedule, now);
		if (until === undefined || until <= now) {
			return 'run';
		}
		this._onProgress.fire({ pipelineId, stepIndex, totalSteps, role: step.role, state: 'waiting', until });
		vibeLog.info('Pipeline', `${pipelineId} шаг ${stepIndex + 1}: ждёт конца пика ${step.model} до ${new Date(until).toISOString()}`);
		return new Promise<'run' | 'cancelled'>(resolve => {
			const store = new DisposableStore();
			let settled = false;
			const finish = (outcome: 'run' | 'cancelled') => {
				if (settled) { return; }
				settled = true;
				store.dispose();
				resolve(outcome);
			};
			const handle = this._notifications.prompt(Severity.Info,
				localize('vibeide.pipeline.offPeakWaiting', 'Пайплайн «{0}»: шаг «{1}» ждёт конца пиковых цен {2} — запуск в {3} UTC.', pipelineId, step.role, step.model ?? '', new Date(until).toISOString().slice(11, 16)),
				[
					{ label: localize('vibeide.pipeline.offPeakRunNow', 'Запустить сейчас'), run: () => finish('run') },
					{ label: localize('vibeide.pipeline.offPeakCancel', 'Отменить прогон'), run: () => finish('cancelled') },
				],
				{ sticky: true },
			);
			store.add(toDisposable(() => handle.close()));
			const timer = setTimeout(() => finish('run'), until - now);
			store.add(toDisposable(() => clearTimeout(timer)));
			store.add(token.onCancellationRequested(() => finish('cancelled')));
		});
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
		// Whether two steps of a wave may write at once depends on where `qa` writes, and that is the
		// project's `.vibe/roles.json` — the same file a run reads.
		const roles = await readRolesFile(this._fileService, this._workspace);
		const parsed = applyWaveRules(parsePipelineFile(result.value), { roleMayWrite, qaWritePaths: roles.qaWritePaths ?? QA_DEFAULT_WRITE_PATHS });
		return { pipelines: parsed.file.pipelines, warnings: parsed.warnings };
	}

	/**
	 * Ссылка на модель из файла пайплайна: логическое имя (`@fast`) разворачивается по таблице имён — блоки
	 * `routes` файлов провайдеров и настройка `vibeide.model.routes`; обычное имя идёт как есть.
	 * Имени, которого нет или которое запрещено (`null`), подстановки не будет: шаг останавливается с объяснением,
	 * как у VibeIDEA, — работа не той моделью дороже остановки.
	 */
	private _modelRefOf(reference: string | undefined, where: string): string | undefined {
		if (!reference) {
			return undefined;
		}
		const resolution = resolveModelReference(reference, this._dynamicProviders.getModelRoutes());
		if (resolution.kind === 'unknown-key') {
			throw new Error(localize('vibeide.pipeline.unknownRoute', '{0}: логического имени «@{1}» нет ни в блоках routes файлов провайдеров, ни в vibeide.model.routes. Известные имена: {2}', where, resolution.key, resolution.known.length > 0 ? resolution.known.map(name => `@${name}`).join(', ') : 'нет'));
		}
		if (resolution.kind === 'disabled') {
			throw new Error(localize('vibeide.pipeline.disabledRoute', '{0}: логическое имя «@{1}» запрещено — в таблице имён ему задан null', where, resolution.key));
		}
		return resolution.reference;
	}

	/**
	 * Ask a second model whether the step's result stands.
	 *
	 * The reviewer is a `code-reviewer` role — read-only by construction, so a critique cannot quietly
	 * become a second implementation. It is told to end with a verdict word, because the pipeline has
	 * to act on the answer and prose cannot be acted on; an answer without one is reported as
	 * «вердикт не распознан» rather than guessed in either direction.
	 *
	 * It is told what the step was asked to do, not what the worker says it did — `composeReviewGoal`
	 * has the reasoning. The setting that brings the worker's account back exists to compare the two,
	 * so the mode is logged next to every verdict and kept in the outcome. It is shown the step's own
	 * diff: without git it would see the files as they are now, not what the step changed in them.
	 */
	private async _review(ctx: PipelineRunContext, step: VibePipelineStep, stepNumber: number, wave: string | undefined, result: SubagentResult, diffBlock: string, runIds: string[]): Promise<PipelineStepOutcome['review']> {
		const reviewer = parseModelRef(this._modelRefOf(step.reviewWith, `шаг ${step.role}, reviewWith`));
		if (!reviewer) {
			return undefined;
		}
		const worker = parseModelRef(this._modelRefOf(step.model, `шаг ${step.role}, model`));
		if (worker && worker.providerName === reviewer.providerName) {
			// Not refused — the provider is a weak proxy for the model family, and one provider does
			// serve several families. Said out loud because a critique by a sibling model is the case
			// where the whole exercise quietly stops working.
			vibeLog.warn('Pipeline', `шаг ${step.role}: ревьюер и исполнитель у одного провайдера (${reviewer.providerName}) — критика своего же семейства`);
		}
		const sawWorkerSummary = this._configuration.getValue<boolean>(CONFIG_REVIEWER_SEES_SUMMARY) === true;
		const goal = composeReviewGoal(step, result.summary, sawWorkerSummary, true);
		const review = await this._spawnAndAwait(ctx, {
			parentThreadId: ctx.parentThreadId,
			// `code-reviewer` is read-only by construction — a critique cannot quietly become a second
			// implementation, which is the failure mode of «let another model fix it».
			type: 'code-reviewer',
			goal,
			...(result.artifacts && result.artifacts.length > 0 ? { contextItems: [...result.artifacts] } : {}),
			modelSelection: { providerName: reviewer.providerName as ProviderId, modelName: reviewer.modelName },
			diff: diffBlock,
			pipelineStepLabel: pipelineStepLabel(stepNumber, ctx.totalSteps, wave, true),
		}, runIds);
		this._subagents.disposeSubagent(review.subagentId);
		const verdict = parseReviewVerdict(review.result.summary);
		vibeLog.info('Pipeline', `шаг ${step.role}: ревью ${step.reviewWith} — ${verdict}, пересказ исполнителя ${sawWorkerSummary ? 'показан' : 'скрыт'}`);
		return { by: step.reviewWith!, verdict, notes: review.result.summary, sawWorkerSummary };
	}

	async run(pipelineId: string, parentThreadId: string, token?: CancellationToken, resume?: { readonly runId: string }): Promise<PipelineRunResult> {
		const { pipelines } = await this.list();
		const pipeline = pipelines.find(p => p.id === pipelineId);
		if (!pipeline) {
			throw new Error(localize('vibeide.pipeline.notFound', 'Пайплайн «{0}» не найден в .vibe/pipelines.json', pipelineId));
		}

		// Read once for the whole run, as VibeIDEA does: editing `.vibe/roles.json` mid-run must not
		// move the write boundary between one `qa` step and the next.
		const roles = await readRolesFile(this._fileService, this._workspace);
		for (const warning of roles.warnings) {
			vibeLog.warn('Pipeline', warning);
		}

		const groups = pipelineGroups(pipeline.steps);
		const runId = generateUuid();
		// The point every judge's diff is measured from, pinned before the first step touches anything.
		// Only when a judge comes after the first group — a pipeline nobody judges leaves no refs behind.
		const judged = groups.slice(1).some(group => pipeline.steps.slice(group.start, group.end + 1).some(wantsRunDiff));
		const baseline = judged ? await this._runDiff.pin(runId, 'base') : undefined;

		// Continuing an interrupted run: its finished steps are taken as they ended, the rest run. Checked again here —
		// the journal may have moved since the person was asked
		const resumed = resume ? await this.interruptedRun(pipelineId) : undefined;
		if (resume && resumed?.record.runId !== resume.runId) {
			throw new Error(localize('vibeide.pipeline.resumeGone', 'Прерванный прогон пайплайна «{0}» продолжить нельзя: он уже продолжен, завершён или пайплайн с тех пор изменился. Запустите его заново.', pipelineId));
		}
		const finished = new Map<number, PipelineStepOutcome>((resumed?.record.outcomes ?? []).filter(o => o.status === 'success').map(o => [o.step - 1, o]));
		if (resumed) {
			vibeLog.info('Pipeline', `${pipelineId}: продолжение прогона ${resumed.record.runId} с шага ${resumed.fromStep + 1}, уже сделано шагов: ${finished.size}`);
		}

		const outcomes: PipelineStepOutcome[] = [];
		const startedAt = Date.now();
		const journal = (status: PipelineRunRecord['status'], finishedAt?: number): Promise<void> => this._recordRun({
			runId, pipelineId, shape: pipelineShapeOf(pipeline), totalSteps: pipeline.steps.length, status, epoch: this._epoch,
			startedAt, heartbeatAt: Date.now(), ...(finishedAt ? { finishedAt } : {}),
			// What an interruption of THIS run leaves to continue from: every step that finished, those taken over included
			outcomes: [...outcomes, ...[...finished.values()].filter(saved => !outcomes.some(o => o.step === saved.step))].sort((a, b) => a.step - b.step),
		});
		await journal('running');
		const heartbeat = new IntervalTimer();
		heartbeat.cancelAndSet(() => void journal('running'), PIPELINE_HEARTBEAT_MS);
		// NOT registered on the service: `run` is called repeatedly, and a source registered per
		// call would accumulate for the lifetime of the window. It is disposed in `finally` below.
		const cancellation = new CancellationTokenSource(token);
		const ctx: PipelineRunContext = {
			pipelineId,
			parentThreadId,
			runId,
			totalSteps: pipeline.steps.length,
			qaWritePaths: roles.qaWritePaths ?? QA_DEFAULT_WRITE_PATHS,
			token: cancellation.token,
			cancel: () => cancellation.cancel(),
			live: new Set<string>(),
			verify: new Sequencer(),
			baseline,
			pinned: baseline !== undefined,
		};
		// «Стоп» stops every step under way, a whole wave included. A limit of a step (`maxTokens`,
		// `maxSteps`) stops only that step — inside the subagent, not here.
		const stopListener = cancellation.token.onCancellationRequested(() => {
			for (const subagentId of [...ctx.live]) {
				this._subagents.disposeSubagent(subagentId);
			}
		});
		let stopped = false;
		try {
			for (const group of groups) {
				if (cancellation.token.isCancellationRequested) { break; }
				outcomes.push(...await this._runGroup(ctx, pipeline, group, [...outcomes], finished));
				await journal('running');
			}
		} finally {
			stopped = cancellation.token.isCancellationRequested;
			heartbeat.dispose();
			stopListener.dispose();
			cancellation.dispose();
			if (ctx.pinned) {
				await this._runDiff.release(runId);
			}
		}
		const everyStepSucceeded = outcomes.length === pipeline.steps.length && outcomes.every(o => o.status === 'success');
		await journal(stopped ? 'stopped' : everyStepSucceeded ? 'completed' : 'failed', Date.now());

		return {
			pipelineId,
			outcomes,
			completed: outcomes.length > 0 && outcomes.every(o => o.status === 'success'),
		};
	}

	/**
	 * One group: a single step, or a wave whose steps start together from the same `before` — what was
	 * known before the wave — and are recorded in file order, whichever finishes first.
	 */
	private async _runGroup(ctx: PipelineRunContext, pipeline: VibePipeline, group: StepGroup, before: readonly PipelineStepOutcome[], finished: ReadonlyMap<number, PipelineStepOutcome>): Promise<PipelineStepOutcome[]> {
		const members: { readonly index: number; readonly step: VibePipelineStep }[] = [];
		for (let index = group.start; index <= group.end; index++) {
			members.push({ index, step: pipeline.steps[index] });
		}
		const results: PipelineStepOutcome[] = new Array(members.length);
		const runnable: number[] = [];
		members.forEach((member, k) => {
			const done = finished.get(member.index);
			if (done) {
				// Finished in the interrupted run this one continues: taken as it ended, not run again — a wave runs only
				// its unfinished members, as in VibeIDEA
				vibeLog.info('Pipeline', `${ctx.pipelineId}: шаг ${member.index + 1} (${member.step.role}) уже сделан в прерванном прогоне — пропущен`);
				this._onProgress.fire({ pipelineId: ctx.pipelineId, stepIndex: member.index, totalSteps: ctx.totalSteps, role: member.step.role, state: 'skipped', ...(group.wave ? { wave: group.wave } : {}) });
				results[k] = done;
			} else if (shouldRunStep(member.step, before)) {
				runnable.push(k);
			} else {
				// Recorded rather than dropped: a reader of the result must see WHY the tail did not
				// run, otherwise a stopped pipeline looks like a shorter pipeline.
				results[k] = this._skipped(ctx, member.index, member.step, group.wave, localize('vibeide.pipeline.skipped', 'Пропущен: предыдущий шаг не удался'));
			}
		});
		if (group.wave !== undefined && runnable.length > 0) {
			// A wave starts whole or not at all: half a wave run is a result nobody planned — the next
			// step would be built on the work of the steps that happened to fit the budget.
			const refusal = await this._waveRefusal(runnable.map(k => members[k].step));
			if (refusal) {
				vibeLog.info('Pipeline', `${ctx.pipelineId}: волна «${group.wave}» не запущена — ${refusal}`);
				for (const k of runnable) {
					results[k] = this._skipped(ctx, members[k].index, members[k].step, group.wave, localize('vibeide.pipeline.waveRefused', 'Волна «{0}» не запущена: {1}', group.wave, refusal));
				}
				return results;
			}
		}
		// Every judge of the group sees the same state — the one before the group — so the diff is taken
		// once, as large as the largest budget, and each judge is cut to its own.
		const judges = runnable.filter(k => receivesRunDiff(members[k].step, before));
		const runDiff = judges.length > 0 ? await this._runDiffOf(ctx, before, Math.max(...judges.map(k => runDiffBudgetChars(members[k].step.maxTokens)))) : undefined;
		await Promise.all(runnable.map(async k => {
			const { index, step } = members[k];
			const diffBlock = runDiff && judges.includes(k) ? composeDiffBlock('run', runDiff, runDiffBudgetChars(step.maxTokens)) : undefined;
			results[k] = await this._runStep(ctx, index, step, group.wave, before, diffBlock);
		}));
		return results;
	}

	/** Why a wave cannot start, or `undefined`: the first of its roles a breaker or a spent budget would refuse. */
	private async _waveRefusal(steps: readonly VibePipelineStep[]): Promise<string | undefined> {
		for (const role of new Set(steps.map(step => step.role))) {
			// An unknown role fails in its own step, loudly; it is not a reason to hold the others.
			if (isSubagentType(role)) {
				const refusal = await this._subagents.launchRefusal(role);
				if (refusal) {
					return refusal;
				}
			}
		}
		return undefined;
	}

	/** Everything the run changed so far: the open folder since the baseline, plus branches not merged into it. */
	private async _runDiffOf(ctx: PipelineRunContext, before: readonly PipelineStepOutcome[], maxChars: number): Promise<CollectedDiff> {
		if (ctx.baseline === undefined) {
			return { sections: [], files: 0, hidden: 0, unavailable: 'снимок перед первым шагом не снят — папка не под git или git недоступен' };
		}
		const branches = [...new Set(before.flatMap(outcome => outcome.unmergedBranches ?? []))];
		return this._runDiff.collect({ since: ctx.baseline, branches, maxChars });
	}

	private _skipped(ctx: PipelineRunContext, index: number, step: VibePipelineStep, wave: string | undefined, summary: string): PipelineStepOutcome {
		this._onProgress.fire({ pipelineId: ctx.pipelineId, stepIndex: index, totalSteps: ctx.totalSteps, role: step.role, state: 'skipped', ...(wave ? { wave } : {}) });
		return { role: step.role, step: index + 1, ...(wave ? { wave } : {}), status: 'skipped', summary, artifacts: [] };
	}

	/**
	 * Spawn a run of the step and wait for it, keeping it where «Стоп» can reach it.
	 *
	 * A stop that came while the spawn was under way has already swept `live` without this id, so the
	 * run is stopped here instead of being left to work unwatched.
	 */
	private async _spawnAndAwait(ctx: PipelineRunContext, handoff: SubagentHandoff, runIds: string[]): Promise<{ readonly subagentId: string; readonly result: SubagentResult }> {
		const subagentId = await this._subagents.spawn(handoff);
		runIds.push(subagentId);
		if (ctx.token.isCancellationRequested) {
			this._subagents.disposeSubagent(subagentId);
			return { subagentId, result: { subagentId, status: 'stopped', summary: localize('vibeide.pipeline.stoppedBeforeStart', 'Прогон остановлен до начала шага.'), tokensUsed: 0 } };
		}
		ctx.live.add(subagentId);
		try {
			return { subagentId, result: await this._subagents.awaitResult(subagentId) };
		} finally {
			ctx.live.delete(subagentId);
		}
	}

	/**
	 * The project's check on a cascade draft: `undefined` when it passed or there is no check to run.
	 *
	 * Runs where the draft's work is — its worktree while the branch is not merged, the open folder
	 * otherwise. Both gate modes count here: `escalateTo` on the step is the author's own request to
	 * escalate a draft that does not work, and a red check is what «does not work» means.
	 */
	private async _verifyDraft(ctx: PipelineRunContext, result: SubagentResult): Promise<string | undefined> {
		const cwd = result.worktree && !result.worktree.merged ? result.worktree.path : this._workspace.getWorkspace().folders[0]?.uri.fsPath ?? null;
		const verdict = await ctx.verify.queue(() => this._verifyGate.runVerify(cwd));
		if (!verdict || verdict.passed) {
			return undefined;
		}
		return localize('vibeide.pipeline.verifyRed', 'проверка проекта «{0}» не прошла (код выхода {1})', verdict.command, verdict.exitCode === null ? localize('vibeide.pipeline.verifyTimeout', 'нет — время вышло') : String(verdict.exitCode));
	}

	/** What the step itself changed, for its reviewer: the folder since the step's pin, or its unmerged branch. */
	private async _stepDiffBlock(ctx: PipelineRunContext, step: VibePipelineStep, stepPin: string | undefined, result: SubagentResult): Promise<string> {
		const budget = runDiffBudgetChars(undefined);
		const branches = result.worktree && !result.worktree.merged ? [result.worktree.branch] : [];
		if (branches.length === 0 && stepPin === undefined) {
			return composeDiffBlock('step', { sections: [], files: 0, hidden: 0, unavailable: 'снимок перед шагом не снят — папка не под git или git недоступен' }, budget);
		}
		// The step's own scope: in a wave the neighbours write at the same time, and their files are not
		// this step's work.
		const stated = step.paths || step.denyPaths ? { ...(step.paths ? { paths: step.paths } : {}), ...(step.denyPaths ? { denyPaths: step.denyPaths } : {}) } : undefined;
		const within = effectiveWriteScope(step.role, stated, ctx.qaWritePaths);
		const diff = await this._runDiff.collect({ ...(branches.length === 0 ? { since: stepPin } : {}), branches, maxChars: budget, ...(within ? { within } : {}) });
		return composeDiffBlock('step', diff, budget);
	}

	private async _runStep(ctx: PipelineRunContext, index: number, step: VibePipelineStep, wave: string | undefined, before: readonly PipelineStepOutcome[], diffBlock: string | undefined): Promise<PipelineStepOutcome> {
		const { pipelineId, totalSteps } = ctx;
		const stepNumber = index + 1;
		const progress = { pipelineId, stepIndex: index, totalSteps, role: step.role, ...(wave ? { wave } : {}) };
		this._onProgress.fire({ ...progress, state: 'started' });
		const input = buildStepInput(step, before, totalSteps);
		const label = pipelineStepLabel(stepNumber, totalSteps, wave);
		const identity = { role: step.role, step: stepNumber, ...(wave ? { wave } : {}) };
		// Runs of this step stay registered until the step is decided: the author's conversation
		// is what a rework continues, and disposing a run releases it.
		const stepRunIds: string[] = [];
		let outcome: PipelineStepOutcome;
		try {
			// An unknown role must fail loudly here. Cast into the union and the subagent would
			// look up a tool whitelist that does not exist — an agent with no tools, silently
			// producing prose instead of work.
			if (!isSubagentType(step.role)) {
				throw new Error(localize('vibeide.pipeline.badRole', 'Неизвестная роль «{0}». Доступны: {1}', step.role, SUBAGENT_TYPES.join(', ')));
			}
			const runStep = async (modelRef: string | undefined, cascadeDraft: boolean, escalatedFrom?: { runId: string; model?: string }, rework?: { runId: string; notes: string }) => {
				const model = parseModelRef(this._modelRefOf(modelRef, `шаг ${step.role}`));
				return this._spawnAndAwait(ctx, {
					parentThreadId: ctx.parentThreadId,
					type: step.role as SubagentType,
					// The rework goes to the author, in its own conversation: it holds why the code is
					// the way it is, and a fresh reader fixes the symptom and breaks the reason.
					goal: rework ? composeReworkRequest(rework.notes) : input.goal,
					...(rework ? { continuesRunId: rework.runId } : {}),
					// Only a reviewed step can come back for rework, so only its runs keep a conversation.
					...(step.reviewWith ? { keepTranscript: true } : {}),
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
					...(step.role === 'qa' ? { qaWritePaths: ctx.qaWritePaths } : {}),
					...(cascadeDraft ? { cascadeDraft: true } : {}),
					...(escalatedFrom ? { escalatedFrom } : {}),
					// A continuation already holds its task message; the diff rides only on a fresh one.
					...(diffBlock && !rework ? { diff: diffBlock } : {}),
					pipelineStepLabel: label,
				}, stepRunIds);
			};

			// Cascade: the cheap model drafts, and the step's own outcome is the gate. Asking a
			// model whether its answer was good enough gets an answer shaped like «yes», so the
			// gate is the run's verdict — the run itself, the project's check, the project's hook.
			if (step.offPeak && await this._waitForOffPeak(step, pipelineId, index, totalSteps, ctx.token) === 'cancelled') {
				// The whole run, not only this step: a cancelled run starts no later step, `continueOnFailure` included.
				ctx.cancel();
				throw new Error(localize('vibeide.pipeline.offPeakCancelled', 'Прогон отменён, пока шаг ждал конца пиковых цен'));
			}
			// The reviewer is shown what THIS step changed, so the tree is pinned right before it — after
			// any off-peak wait, or the user's edits of those hours would count as the step's.
			const stepPin = step.reviewWith ? await this._runDiff.pin(ctx.runId, `step-${stepNumber}`) : undefined;
			if (stepPin !== undefined) {
				ctx.pinned = true;
			}
			const drafting = step.escalateTo !== undefined;
			const first = await runStep(step.model, drafting);
			let result = first.result;
			let authorRunId = first.subagentId;
			let escalated = false;
			// The step's work, run by run: the branch each isolated run left unmerged. A draft that
			// escalation replaced is dropped from it — its work is not the step's answer.
			let branchesOfResult = unmergedBranchOf(result);
			// Project-owned gates on top of the step's own outcome: a draft can succeed and still not
			// work. A red verify check comes first — it is the project's definition of «works» — then
			// the `pipelineStepEnd` hook, whose exit 2 rejects the draft. No check, no hook, hooks off,
			// or a broken script — the outcome decides as before.
			let rejectedByGate: string | undefined;
			if (drafting && result.status === 'success' && !ctx.token.isCancellationRequested) {
				rejectedByGate = await this._verifyDraft(ctx, result);
				if (rejectedByGate === undefined) {
					const gate = await this._hooks.run('pipelineStepEnd', {
						pipeline: pipelineId,
						step: stepNumber,
						role: step.role,
						model: step.model,
						...(wave ? { wave } : {}),
						answer: result.summary,
					});
					if (gate.blocked) {
						rejectedByGate = gate.agentMessage ?? localize('vibeide.pipeline.gateRefused', 'хук pipelineStepEnd не принял черновик');
					}
				}
				if (rejectedByGate !== undefined) {
					vibeLog.info('Pipeline', `${pipelineId} шаг ${stepNumber}: гейт отклонил черновик — ${rejectedByGate}`);
				}
			}
			if (drafting && (result.status !== 'success' || rejectedByGate !== undefined) && !ctx.token.isCancellationRequested) {
				vibeLog.info('Pipeline', `${pipelineId} шаг ${stepNumber}: ${rejectedByGate ? 'гейт отклонил черновик' : 'черновик не прошёл'}, эскалация на ${step.escalateTo}`);
				this._onProgress.fire({ ...progress, state: 'started' });
				// The draft's model is named only when the step named it: an empty string would look
				// like a model in the report, and «ran on the role's default» is the honest answer.
				const second = await runStep(step.escalateTo, false, { runId: first.subagentId, ...(step.model ? { model: step.model } : {}) });
				result = second.result;
				authorRunId = second.subagentId;
				escalated = true;
				branchesOfResult = unmergedBranchOf(result);
			}
			// Critique: a second model reads the result and says whether it stands. Only after a
			// successful run — reviewing a step that failed tells the user what they already
			// know, and costs a model call to say it.
			let review: PipelineStepOutcome['review'];
			if (step.reviewWith && result.status === 'success' && !ctx.token.isCancellationRequested) {
				review = await this._review(ctx, step, stepNumber, wave, result, await this._stepDiffBlock(ctx, step, stepPin, result), stepRunIds);
				if (review?.verdict === 'rework' && !ctx.token.isCancellationRequested) {
					vibeLog.info('Pipeline', `${pipelineId} шаг ${stepNumber}: ревьюер требует доработки, переделываю один раз`);
					this._onProgress.fire({ ...progress, state: 'started' });
					// One revision, not a loop: two models disagreeing can trade opinions forever,
					// and the user is paying per exchange. The verdict travels with the outcome, so
					// a result that stayed unconvincing is visible rather than retried in silence.
					const revised = await runStep(escalated ? step.escalateTo : step.model, false, undefined, { runId: authorRunId, notes: review.notes });
					// The files the author touched before the rework are still the step's result.
					const artifacts = [...new Set([...(result.artifacts ?? []), ...(revised.result.artifacts ?? [])])];
					result = { ...revised.result, artifacts };
					branchesOfResult = [...branchesOfResult, ...unmergedBranchOf(revised.result)];
				}
			}
			outcome = {
				...identity,
				status: result.status,
				summary: result.summary,
				artifacts: result.artifacts ?? [],
				...(branchesOfResult.length > 0 ? { unmergedBranches: branchesOfResult } : {}),
				...(escalated ? { escalatedTo: step.escalateTo } : {}),
				...(review ? { review } : {}),
			};
		} catch (err) {
			// A step that could not even start is a failed step, not a crashed pipeline: the
			// outcomes collected so far are the user's answer to "what did it manage to do".
			vibeLog.error('Pipeline', `${pipelineId} шаг ${stepNumber} (${step.role}): ${err}`);
			outcome = {
				...identity,
				status: ctx.token.isCancellationRequested ? 'stopped' : 'failed',
				summary: err instanceof Error ? err.message : String(err),
				artifacts: [],
			};
		} finally {
			for (const runId of stepRunIds) {
				this._subagents.disposeSubagent(runId);
			}
		}
		this._onProgress.fire({ ...progress, state: 'finished' });
		return outcome;
	}
}

/** The branch an isolated run left its work on, when that branch was not merged into the folder. */
function unmergedBranchOf(result: SubagentResult): string[] {
	return result.worktree && !result.worktree.merged ? [result.worktree.branch] : [];
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
		const pipelineId = picked.id;
		const totalSteps = pipelines.find(p => p.id === pipelineId)?.steps.length ?? 0;

		// An interrupted run is offered, not taken: the files may have moved on since, and whether the finished steps still
		// stand is the person's call — as VibeIDEA asks it
		let resume: { readonly runId: string } | undefined;
		const interrupted = await pipelineService.interruptedRun(pipelineId);
		if (interrupted) {
			const why = interrupted.reason === 'stopped' ? localize('vibeide.pipeline.resume.stopped', 'остановлен кнопкой «Стоп»')
				: interrupted.reason === 'failed' ? localize('vibeide.pipeline.resume.failed', 'шаг не удался')
					: localize('vibeide.pipeline.resume.orphaned', 'окно закрылось посреди прогона');
			const choice = await quickInput.pick([
				{ id: 'resume', label: localize('vibeide.pipeline.resume.continue', 'Продолжить с шага {0}', interrupted.fromStep + 1), detail: localize('vibeide.pipeline.resume.detail', 'Сделанные шаги ({0} из {1}) не повторяются, их итоги и файлы получат следующие шаги. Файлы с тех пор могли измениться.', interrupted.done.size, interrupted.record.totalSteps) },
				{ id: 'restart', label: localize('vibeide.pipeline.resume.restart', 'Запустить заново') },
			], { placeHolder: localize('vibeide.pipeline.resume.ask', 'Прошлый прогон «{0}» прерван: {1}.', pipelineId, why) });
			if (!choice) { return; }
			resume = choice.id === 'resume' ? { runId: interrupted.record.runId } : undefined;
		}

		const parentThreadId = chatThreads.getCurrentThread().id;
		// The run is visible while it lasts and can be stopped: a wave of three agents working at once
		// is not something to leave running with no way to call it off.
		const store = new DisposableStore();
		const cancellation = store.add(new CancellationTokenSource());
		const running = new Map<number, string>();
		const handle = notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.pipeline.started', 'Пайплайн «{0}» запущен.', pipelineId),
			sticky: true,
			progress: { infinite: true },
			actions: { primary: [toAction({ id: 'vibeide.pipeline.stop', label: localize('vibeide.pipeline.stop', 'Стоп'), run: () => cancellation.cancel() })] },
		});
		store.add(toDisposable(() => handle.close()));
		store.add(pipelineService.onProgress(event => {
			if (event.pipelineId !== pipelineId) { return; }
			if (event.state === 'started' || event.state === 'waiting') {
				const label = pipelineStepLabel(event.stepIndex + 1, event.totalSteps, event.wave);
				running.set(event.stepIndex, event.state === 'waiting' ? localize('vibeide.pipeline.progressWaiting', '{0} · {1} ждёт конца пиковых цен', label, event.role) : `${label} · ${event.role}`);
			} else {
				running.delete(event.stepIndex);
			}
			if (running.size > 0) {
				handle.updateMessage(localize('vibeide.pipeline.progress', 'Пайплайн «{0}»: {1}', pipelineId, [...running.values()].join('; ')));
			}
		}));
		try {
			const result = await pipelineService.run(pipelineId, parentThreadId, cancellation.token, resume);
			const done = result.outcomes.filter(o => o.status === 'success').length;
			const failed = result.outcomes.filter(o => o.status !== 'success');
			notifications.notify({
				severity: failed.length === 0 && !cancellation.token.isCancellationRequested ? Severity.Info : Severity.Warning,
				message: cancellation.token.isCancellationRequested
					? localize('vibeide.pipeline.stopped', 'Пайплайн «{0}» остановлен: успели {1} из {2} шагов.', pipelineId, done, totalSteps)
					: failed.length === 0
						? localize('vibeide.pipeline.done', 'Пайплайн «{0}» прошёл целиком: {1} шага(ов).', pipelineId, result.outcomes.length)
						: localize('vibeide.pipeline.partial', 'Пайплайн «{0}»: удалось {1} из {2}. Первая заминка — шаг «{3}»: {4}',
							pipelineId, done, result.outcomes.length, failed[0].role, failed[0].summary),
			});
		} catch (err) {
			notifications.notify({ severity: Severity.Error, message: String(err instanceof Error ? err.message : err) });
		} finally {
			store.dispose();
		}
	}
});
