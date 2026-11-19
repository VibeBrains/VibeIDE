/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Code Mode — сторона окна: запуск скрипта и ответы на вложенные вызовы
 *
 * Подписка на события канала одна на сервис и живёт всё время: переподписка на каждый скрипт
 * теряет поток (см. `vibeVoiceInputService.ts` — там этот капкан описан подробно). Поэтому
 * запросы песочницы разбираются по `executionId`, а не по свежему слушателю
 */

import { generateUuid } from '../../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { ICodeModeOutcome, ICodeModeCallRequest, VIBE_CODE_MODE_CHANNEL, codeModeErrorMessage } from '../../common/codeMode/codeModeIpc.js';
import { ICodeModeSandboxOptions, IVibeCodeModeSandboxService } from '../../common/codeMode/codeModeSandboxService.js';

export class VibeCodeModeSandboxService implements IVibeCodeModeSandboxService {

	declare readonly _serviceBrand: undefined;

	/** Куда возвращать вложенные вызовы: прогон живёт, пока не ответит канал */
	private readonly handlers = new Map<string, ICodeModeSandboxOptions>();

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) {
		this.mainProcessService.getChannel(VIBE_CODE_MODE_CHANNEL).listen<ICodeModeCallRequest>('onToolCall')(request => {
			void this.dispatchToolCall(request);
		});
	}

	private async dispatchToolCall(request: ICodeModeCallRequest): Promise<void> {
		const options = this.handlers.get(request.executionId);
		if (!options) {
			return;
		}
		let answer: { ok: boolean; text: string };
		try {
			answer = await options.callTool(request.tool, request.argsJson);
		} catch (error) {
			answer = { ok: false, text: codeModeErrorMessage(error) };
		}
		try {
			await this.mainProcessService.getChannel(VIBE_CODE_MODE_CHANNEL).call('toolResult', {
				executionId: request.executionId,
				callId: request.callId,
				ok: answer.ok,
				text: answer.text,
			});
		} catch {
			// Прогон уже закрыт (таймаут, убийство процесса) — ответ опоздал и никому не нужен
		}
	}

	async run(script: string, options: ICodeModeSandboxOptions): Promise<ICodeModeOutcome> {
		const executionId = generateUuid();
		this.handlers.set(executionId, options);
		try {
			return await this.mainProcessService.getChannel(VIBE_CODE_MODE_CHANNEL).call<ICodeModeOutcome>('run', {
				executionId,
				script,
				timeoutMs: options.timeoutSec * 1000,
				maxCalls: options.maxCalls,
			});
		} catch (error) {
			return { logs: [], calls: [], error: codeModeErrorMessage(error) };
		} finally {
			this.handlers.delete(executionId);
		}
	}
}

registerSingleton(IVibeCodeModeSandboxService, VibeCodeModeSandboxService, InstantiationType.Delayed);
