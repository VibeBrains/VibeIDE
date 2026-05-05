/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';

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
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	isAvailable(): boolean {
		return this.getMode() !== 'unavailable';
	}

	getMode(): 'whisper-local' | 'web-speech' | 'unavailable' {
		const whisperPath = this._configurationService.getValue<string>('vibeide.voice.whisperPath');
		if (whisperPath) return 'whisper-local';

		// Check Web Speech API availability
		if (typeof window !== 'undefined' && 'webkitSpeechRecognition' in window) {
			// Only allow Web Speech if NOT in privacy mode
			const isPrivacy = this._configurationService.getValue<boolean>('vibeide.stealthMode.enabled') ?? false;
			if (!isPrivacy) return 'web-speech';
		}

		return 'unavailable';
	}

	startRecording(): void {
		this._logService.info('[VibeIDE Voice] Phase 3b: recording started');
	}

	async stopRecording(): Promise<string | null> {
		this._logService.info('[VibeIDE Voice] Phase 3b: recording stopped');
		return null;
	}
}

registerSingleton(IVibeVoiceInputService, VibeVoiceInputService, InstantiationType.Delayed);
