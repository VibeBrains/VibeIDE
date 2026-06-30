/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';

import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Surface the voice-input whisper path in VS Code's Settings UI. Without this
// block the key read by `getMode()` exists only as the bare `getValue` return,
// so users never see it in the editor and can't point voice input at a local
// whisper.cpp binary without editing settings.json by hand.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.voice.whisperPath': {
			type: 'string',
			default: '',
			description: localize('vibeide.voice.whisperPath', 'Абсолютный путь к whisper.cpp бинарю для локального speech-to-text. Пустая строка → fallback на Web Speech API (если доступен и privacy-mode выключен), иначе voice input недоступен. Privacy-strict режим (`vibeide.stealthMode.enabled = true`) принудительно отключает Web Speech, оставляя только whisper-local через этот путь.'),
		},
	},
});

export const IVibeVoiceInputService = createDecorator<IVibeVoiceInputService>('vibeVoiceInputService');

export interface IVibeVoiceInputService {
	readonly _serviceBrand: undefined;

	/** Whether voice input is available */
	isAvailable(): boolean;

	/** Start recording */
	startRecording(): void;

	/** Stop recording and get transcript */
	stopRecording(): Promise<string | null>;

	/** Whether using local Whisper (privacy) or Web Speech API */
	getMode(): 'whisper-local' | 'web-speech' | 'unavailable';

	readonly onTranscript: Event<string>;
}

/**
 * VibeIDE Voice Input.
 * Whisper.cpp locally OR Web Speech API.
 * In privacy mode: ONLY local Whisper (audio never sent to cloud).
 *
 * Phase 3b: actual Whisper.cpp integration via IPC.
 */
class VibeVoiceInputService extends Disposable implements IVibeVoiceInputService {
	declare readonly _serviceBrand: undefined;

	private readonly _onTranscript = this._register(new Emitter<string>());
	readonly onTranscript = this._onTranscript.event;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	isAvailable(): boolean {
		return this.getMode() !== 'unavailable';
	}

	getMode(): 'whisper-local' | 'web-speech' | 'unavailable' {
		const whisperPath = this._configurationService.getValue<string>('vibeide.voice.whisperPath');
		if (whisperPath) { return 'whisper-local'; }

		// Check Web Speech API availability
		if (typeof window !== 'undefined' && Object.hasOwn(window, 'webkitSpeechRecognition')) {
			// Only allow Web Speech if NOT in privacy mode
			const isPrivacy = this._configurationService.getValue<boolean>('vibeide.stealthMode.enabled') ?? false;
			if (!isPrivacy) { return 'web-speech'; }
		}

		return 'unavailable';
	}

	startRecording(): void {
		vibeLog.info('Voice', 'Phase 3b: recording started');
	}

	async stopRecording(): Promise<string | null> {
		vibeLog.info('Voice', 'Phase 3b: recording stopped');
		return null;
	}
}

registerSingleton(IVibeVoiceInputService, VibeVoiceInputService, InstantiationType.Delayed);
