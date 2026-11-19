/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Code Mode — IPC-канал главного процесса
 *
 * Сырой `IServerChannel`, а не `ProxyChannel`: пока скрипт жив, песочница присылает запросы
 * «выполни инструмент» событием, и окно отвечает им обратно. Направление «главный → окно»
 * в прокси не выражается, поэтому команды и событие описаны руками
 */

import { Event } from '../../../../../base/common/event.js';
import { IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ICodeModeCallResult, ICodeModeRunRequest } from '../../common/codeMode/codeModeIpc.js';
import { VibeCodeModeMainService } from './codeModeMainService.js';

export class VibeCodeModeChannel implements IServerChannel {

	constructor(private readonly service: VibeCodeModeMainService) { }

	listen<T>(_: unknown, event: string): Event<T> {
		if (event === 'onToolCall') {
			return this.service.onToolCall as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_: unknown, command: string, arg: unknown): Promise<T> {
		switch (command) {
			case 'run':
				return await this.service.run(arg as ICodeModeRunRequest) as T;
			case 'toolResult':
				this.service.toolResult(arg as ICodeModeCallResult);
				return undefined as T;
		}
		throw new Error(`Unknown command: ${command}`);
	}
}
