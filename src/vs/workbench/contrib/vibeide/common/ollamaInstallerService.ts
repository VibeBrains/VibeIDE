/*--------------------------------------------------------------------------------------
 *  Minimal installer service that proxies to main channel and exposes events
 *--------------------------------------------------------------------------------------*/
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';

export interface InstallOptions { method: 'auto' | 'brew' | 'curl' | 'winget' | 'choco', modelTag?: string }

export interface IOllamaInstallerService {
  readonly _serviceBrand: undefined;
  onLog: Event<string>;
  onDone: Event<boolean>;
  install(options: InstallOptions): void;
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
    channel.listen('onLog')((e: any) => this._onLog.fire((e as { text: string }).text));
    channel.listen('onDone')((e: any) => this._onDone.fire((e as { ok: boolean }).ok));
  }

  install(options: InstallOptions) {
    const channel = this.mainProcessService.getChannel('vibe-channel-ollamaInstaller');
    channel.call('install', options);
  }
}


