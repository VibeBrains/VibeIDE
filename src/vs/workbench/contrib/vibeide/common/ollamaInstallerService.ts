/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface InstallOptions { method: 'auto' | 'brew' | 'curl' | 'winget' | 'choco'; modelTag?: string }
export interface ProbeResult { running: boolean; modelCount: number }

export interface IOllamaInstallerService {
	readonly _serviceBrand: undefined;
	onLog: Event<string>;
	onDone: Event<boolean>;
	install(options: InstallOptions): void;
	probe(): Promise<ProbeResult>;
}

export const IOllamaInstallerService = createDecorator<IOllamaInstallerService>('OllamaInstallerService');

// Реализация — `electron-browser/ollamaInstallerService.ts`: установка Ollama это запуск пакетного
// менеджера в main-процессе через `IMainProcessService`, запрещённый и в `common/**`, и в `browser/**`.
