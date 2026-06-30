/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

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
}

registerSingleton(IOllamaInstallerService, OllamaInstallerService, InstantiationType.Delayed);


