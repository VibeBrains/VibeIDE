/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Desktop implementation of `IOllamaInstallerService` (contract lives in
 * `../common/ollamaInstallerService.ts`).
 *
 * Installing Ollama means running a package manager (brew / winget / choco / curl) — inherently a
 * main-process job, reached here through `IMainProcessService`, which is banned in `common/**` and
 * `browser/**` alike. Hence the split: contract in `common/`, class here.
 *
 * Unlike the other proxies this one does not use `ProxyChannel`: it needs `channel.listen` for the
 * `onLog` / `onDone` push streams (install progress is emitted from main while the install runs),
 * so it holds the raw channel and re-fires into local Emitters.
 *
 * Loaded from `vs/workbench/workbench.desktop.main.ts` — a browser-layer module cannot import
 * electron-browser. Registration still happens before any consumer resolves the decorator:
 * `registerSingleton` only records a descriptor, and every import in `workbench.desktop.main.ts`
 * completes before the workbench instantiates its contributions.
 */

import { Emitter } from '../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { InstallOptions, IOllamaInstallerService, LocalModelDetails, LocalModelEntry, ProbeResult } from '../common/ollamaInstallerService.js';

export class OllamaInstallerService implements IOllamaInstallerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onLog = new Emitter<string>();
	readonly onLog = this._onLog.event;

	private readonly _onDone = new Emitter<boolean>();
	readonly onDone = this._onDone.event;

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) {
		const channel = this.mainProcessService.getChannel('vibe-channel-ollamaInstaller');
		channel.listen<{ text: string }>('onLog')(e => this._onLog.fire(e.text));
		channel.listen<{ ok: boolean }>('onDone')(e => this._onDone.fire(e.ok));
	}

	install(options: InstallOptions) {
		const channel = this.mainProcessService.getChannel('vibe-channel-ollamaInstaller');
		channel.call('install', options);
	}

	async probe(): Promise<ProbeResult> {
		const channel = this.mainProcessService.getChannel('vibe-channel-ollamaInstaller');
		return channel.call('probe', undefined);
	}

	// The three reads below back the «will this model run here?» estimate. Each answers with an
	// empty result rather than throwing: Ollama not running is an ordinary state on most machines,
	// and a rejected promise here would surface as an error where there is no error.

	async listModels(): Promise<LocalModelEntry[]> {
		const channel = this.mainProcessService.getChannel('vibe-channel-ollamaInstaller');
		return channel.call<LocalModelEntry[]>('listModels', undefined).catch(() => []);
	}

	async inspectModel(tag: string): Promise<LocalModelDetails> {
		const channel = this.mainProcessService.getChannel('vibe-channel-ollamaInstaller');
		return channel.call<LocalModelDetails>('inspectModel', tag).catch(() => ({}));
	}

	async hostMemoryBytes(): Promise<number> {
		const channel = this.mainProcessService.getChannel('vibe-channel-ollamaInstaller');
		return channel.call<number>('hostMemoryBytes', undefined).catch(() => 0);
	}
}

registerSingleton(IOllamaInstallerService, OllamaInstallerService, InstantiationType.Delayed);
