/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Десктопная реализация `IVibeAcpService` (контракт — в `../../common/acp/vibeAcpService.ts`).
 *
 * Здесь только доставка: процесс агента живёт в main, поэтому ходим туда через `IMainProcessService`,
 * который в `common/**` запрещён. Смысловая часть — чекпоинт перед правкой, журнал и очередь
 * вопросов человеку — лежит в `browser/acp/vibeAcpSessionsService.ts`: на запрос разрешения есть
 * ровно один ответ, и решать, кто его даёт, обязано одно место, а не два слоя.
 */

import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { AcpEvent, IAcpAgentLaunch, IAcpSession, IVibeAcpMain, VIBE_ACP_CHANNEL } from '../../common/acp/acpTypes.js';
import { AcpStopReason } from '../../common/acp/acpProtocol.js';
import { IVibeAcpService } from '../../common/acp/vibeAcpService.js';

export class VibeAcpService implements IVibeAcpService {
	declare readonly _serviceBrand: undefined;

	private readonly _proxy: IVibeAcpMain;
	readonly onEvent: Event<AcpEvent>;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		this._proxy = ProxyChannel.toService<IVibeAcpMain>(mainProcessService.getChannel(VIBE_ACP_CHANNEL));
		this.onEvent = this._proxy.onEvent;
	}

	startSession(launch: IAcpAgentLaunch): Promise<IAcpSession> {
		return this._proxy.startSession(launch);
	}

	prompt(sessionId: string, text: string): Promise<AcpStopReason> {
		return this._proxy.prompt(sessionId, text);
	}

	answerPermission(requestId: string, optionId: string | undefined): Promise<void> {
		return this._proxy.answerPermission(requestId, optionId);
	}

	cancel(sessionId: string): Promise<void> {
		return this._proxy.cancel(sessionId);
	}

	endSession(sessionId: string): Promise<void> {
		return this._proxy.endSession(sessionId);
	}
}

registerSingleton(IVibeAcpService, VibeAcpService, InstantiationType.Delayed);
