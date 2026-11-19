/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Code Mode — главный процесс: один utility-процесс-песочница на один скрипт
 *
 * Скрипт не должен исполняться ни в окне, ни здесь. Процесс поднимается на прогон и
 * убивается после ответа: так таймаут, зависание и нехватка памяти остаются внутри
 * песочницы, а следующий вызов модели начинается с чистого состояния
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ILifecycleMainService } from '../../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { UtilityProcess } from '../../../../../platform/utilityProcess/electron-main/utilityProcess.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { CodeModeWorkerRequest, CodeModeWorkerResponse, ICodeModeCallRequest, ICodeModeCallResult, ICodeModeOutcome, ICodeModeRunRequest } from '../../common/codeMode/codeModeIpc.js';

const WORKER_ENTRY_POINT = 'vs/workbench/contrib/vibeide/node/codeMode/codeModeSandboxMain';
/** Память песочницы: скрипт модели не должен иметь возможности съесть память машины */
const SANDBOX_MAX_OLD_SPACE_MB = 128;
/** Запас к таймауту: процесс снимается чуть позже, чем скрипт сам сдаётся по часам */
const KILL_GRACE_MS = 2_000;

interface IExecution {
	readonly worker: UtilityProcess;
	readonly finish: (outcome: ICodeModeOutcome) => void;
}

export class VibeCodeModeMainService extends Disposable {

	private readonly _onToolCall = this._register(new Emitter<ICodeModeCallRequest>());
	readonly onToolCall = this._onToolCall.event;

	private readonly executions = new Map<string, IExecution>();

	constructor(
		private readonly logService: ILogService,
		private readonly lifecycleMainService: ILifecycleMainService,
	) {
		super();
	}

	run(request: ICodeModeRunRequest): Promise<ICodeModeOutcome> {
		return new Promise<ICodeModeOutcome>(resolve => {
			const worker = new UtilityProcess(this.logService, NullTelemetryService, this.lifecycleMainService);

			// Вложенный `while (true)` без await блокирует event loop процесса целиком,
			// поэтому таймер внутри песочницы уже не сработает — снимать процесс должен главный
			const watchdog = setTimeout(() => {
				this.logService.warn(`[CodeMode] скрипт не уложился в ${request.timeoutMs} мс — процесс снят`);
				finish({ logs: [], calls: [], error: localize('vibeide.codeMode.timeout', "Скрипт Code Mode не уложился во время и был остановлен") });
			}, Math.max(1000, request.timeoutMs) + KILL_GRACE_MS);

			const finish = (outcome: ICodeModeOutcome) => {
				if (!this.executions.delete(request.executionId)) {
					return;
				}
				clearTimeout(watchdog);
				worker.kill();
				resolve(outcome);
			};

			this.executions.set(request.executionId, { worker, finish });

			worker.onMessage(message => {
				const response = message as CodeModeWorkerResponse;
				if (response.t === 'toolCall') {
					this._onToolCall.fire(response);
					return;
				}
				if (response.t === 'done') {
					finish(response.outcome);
				}
			});
			const crashed = (reason: string) => {
				this.logService.warn(`[CodeMode] песочница завершилась (${reason})`);
				finish({
					logs: [],
					calls: [],
					error: localize('vibeide.codeMode.crashed', "Процесс Code Mode завершился до ответа ({0})", reason),
				});
			};
			worker.onExit(() => crashed('exit'));
			worker.onCrash(() => crashed('crash'));

			worker.start({
				type: 'vibeCodeMode',
				name: 'vibe-code-mode',
				entryPoint: WORKER_ENTRY_POINT,
				correlationId: request.executionId,
				execArgv: [`--max-old-space-size=${SANDBOX_MAX_OLD_SPACE_MB}`],
			});
			worker.postMessage({
				t: 'run',
				executionId: request.executionId,
				script: request.script,
				timeoutMs: request.timeoutMs,
				maxCalls: request.maxCalls,
			} satisfies CodeModeWorkerRequest);
		});
	}

	/** Ответ окна на `tools.<имя>(args)`: песочница ждёт его, как обычный промис */
	toolResult(result: ICodeModeCallResult): void {
		this.executions.get(result.executionId)?.worker.postMessage({ t: 'toolResult', ...result } satisfies CodeModeWorkerRequest);
	}

	override dispose(): void {
		for (const execution of this.executions.values()) {
			execution.worker.kill();
		}
		this.executions.clear();
		super.dispose();
	}
}
