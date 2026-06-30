/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ITerminalService } from '../../../contrib/terminal/browser/terminal.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

export const IVibeTerminalOutputService = createDecorator<IVibeTerminalOutputService>('vibeTerminalOutputService');

export interface TerminalOutputEvent {
	terminalId: string;
	output: string;
	timestamp: number;
}

export interface IVibeTerminalOutputService {
	readonly _serviceBrand: undefined;

	/** Get latest output from active terminal (opt-in) */
	getLatestOutput(maxChars?: number): string | null;

	/** Whether terminal awareness is enabled */
	isEnabled(): boolean;

	/** Event fired when terminal output changes */
	readonly onTerminalOutput: Event<TerminalOutputEvent>;
}

/**
 * VibeIDE Terminal Output Awareness (opt-in).
 * Allows agent to see terminal output in real-time.
 * Closes feedback loop: agent runs test → sees failure → fixes without manual copy-paste.
 *
 * Disabled by default. Enable via: vibeide.agent.terminalOutputAwareness: true
 */
class VibeTerminalOutputService extends Disposable implements IVibeTerminalOutputService {
	declare readonly _serviceBrand: undefined;

	private readonly _onTerminalOutput = this._register(new Emitter<TerminalOutputEvent>());
	readonly onTerminalOutput = this._onTerminalOutput.event;

	private _latestOutput: string = '';
	private _enabled: boolean = false;

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._enabled = this._configurationService.getValue<boolean>('vibeide.agent.terminalOutputAwareness') ?? false;

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.agent.terminalOutputAwareness')) {
				this._enabled = this._configurationService.getValue<boolean>('vibeide.agent.terminalOutputAwareness') ?? false;
				if (this._enabled) {
					this._setupTerminalListeners();
				}
			}
		}));

		if (this._enabled) {
			this._setupTerminalListeners();
		}
	}

	private _setupTerminalListeners(): void {
		vibeLog.info('TerminalOutput', 'Terminal output awareness enabled (opt-in)');

		// Listen to terminal data events
		this._register(this._terminalService.onDidChangeActiveInstance(terminal => {
			if (!terminal) { return; }
			this._register(terminal.onData(data => {
				if (!this._enabled) { return; }
				this._latestOutput = (this._latestOutput + data).slice(-50_000); // keep last 50KB
				this._onTerminalOutput.fire({
					terminalId: terminal.instanceId.toString(),
					output: data,
					timestamp: Date.now(),
				});
			}));
		}));
	}

	isEnabled(): boolean {
		return this._enabled;
	}

	getLatestOutput(maxChars: number = 5000): string | null {
		if (!this._enabled) { return null; }
		return this._latestOutput.slice(-maxChars);
	}
}

registerSingleton(IVibeTerminalOutputService, VibeTerminalOutputService, InstantiationType.Delayed);
