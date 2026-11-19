/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICodeModeOutcome } from './codeModeIpc.js';

/** Что окно умеет делать с одним вложенным вызовом: проверить, спросить человека, выполнить, записать в аудит */
export interface ICodeModeToolCallAnswer {
	readonly ok: boolean;
	readonly text: string;
}

export interface ICodeModeSandboxOptions {
	readonly timeoutSec: number;
	readonly maxCalls: number;
	/** Возврат в окно за каждым `tools.<имя>(args)` — иначе песочница обходила бы одобрения */
	callTool(tool: string, argsJson: string): Promise<ICodeModeToolCallAnswer>;
}

export const IVibeCodeModeSandboxService = createDecorator<IVibeCodeModeSandboxService>('vibeCodeModeSandboxService');

export interface IVibeCodeModeSandboxService {
	readonly _serviceBrand: undefined;
	run(script: string, options: ICodeModeSandboxOptions): Promise<ICodeModeOutcome>;
}
