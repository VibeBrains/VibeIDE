/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface InstallOptions { method: 'auto' | 'brew' | 'curl' | 'winget' | 'choco'; modelTag?: string }
export interface ProbeResult { running: boolean; modelCount: number }

/** A model already pulled onto this machine (`/api/tags`). */
export interface LocalModelEntry {
	readonly name: string;
	/** Size on disk in bytes — measured, so the quantization does not have to be guessed. */
	readonly sizeBytes: number;
	/** As reported by Ollama, e.g. `Q4_K_M`; shown to the user, never used in arithmetic. */
	readonly quantization?: string;
	/** As reported by Ollama, e.g. `8.0B`; likewise for display only. */
	readonly parameterSize?: string;
}

/**
 * What the machine and a given model look like, for the «will this run here?» estimate.
 * `modelInfo` is `/api/show` → `model_info` passed through untouched: its keys are prefixed with
 * the architecture, so it is parsed by `parseModelShape` rather than typed field by field.
 */
export interface LocalModelDetails {
	readonly modelInfo?: Record<string, unknown>;
}

export interface IOllamaInstallerService {
	readonly _serviceBrand: undefined;
	onLog: Event<string>;
	onDone: Event<boolean>;
	install(options: InstallOptions): void;
	probe(): Promise<ProbeResult>;
	/** Models already on disk. Empty when Ollama is not running — never throws. */
	listModels(): Promise<LocalModelEntry[]>;
	/** Architecture metadata for one model, for an honest KV-cache figure. */
	inspectModel(tag: string): Promise<LocalModelDetails>;
	/** Total machine memory in bytes; 0 when it cannot be determined. */
	hostMemoryBytes(): Promise<number>;
}

export const IOllamaInstallerService = createDecorator<IOllamaInstallerService>('OllamaInstallerService');

// Реализация — `electron-browser/ollamaInstallerService.ts`: установка Ollama это запуск пакетного
// менеджера в main-процессе через `IMainProcessService`, запрещённый и в `common/**`, и в `browser/**`.
