/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILocalTranscriptionModelImportResult, ILocalTranscriptionModelStatus, ILocalTranscriptionResult, ILocalTranscriptionService, LocalTranscriptionModelState } from '../../../../platform/localTranscription/common/localTranscription.js';

/**
 * On-device transcription is reported as unavailable in VibeIDE.
 *
 * Upstream dictation runs on Foundry Local: it downloads a vendor speech model from
 * Microsoft's CDN on first use. VibeIDE ships its own local recognition instead
 * (sherpa-onnx in a utility process, see `contrib/vibeide/**\/voice`), registered as a
 * provider of `ISpeechService`, so editor, terminal and chat dictation all work without
 * fetching anything.
 *
 * The upstream interface stays wired so that upstream call sites compile and gracefully
 * degrade: `isSupported === false` is exactly the state they already handle on platforms
 * without a native runtime.
 */
export class LocalTranscriptionService implements ILocalTranscriptionService {

	declare readonly _serviceBrand: undefined;

	readonly isSupported = false;

	private readonly _onDidChangeModelStatus = new Emitter<ILocalTranscriptionModelStatus>();
	readonly onDidChangeModelStatus: Event<ILocalTranscriptionModelStatus> = this._onDidChangeModelStatus.event;

	private readonly _onDidTranscribe = new Emitter<ILocalTranscriptionResult>();
	readonly onDidTranscribe: Event<ILocalTranscriptionResult> = this._onDidTranscribe.event;

	async getModelStatus(): Promise<ILocalTranscriptionModelStatus> {
		// `Idle` is the state upstream shows when no model has been requested; combined with
		// `isSupported === false` the dictation UI stays hidden rather than offering a download.
		return { state: LocalTranscriptionModelState.Idle };
	}

	async importModel(): Promise<ILocalTranscriptionModelImportResult> {
		throw new Error('On-device transcription model import is not available in VibeIDE.');
	}

	async start(): Promise<void> {
		throw new Error('On-device transcription is not available in VibeIDE; speech runs through ISpeechService.');
	}

	async pushAudio(_chunk: VSBuffer): Promise<void> {
		// no session can be started, so there is nothing to receive audio
	}

	async stop(): Promise<string> {
		return '';
	}

	async cancel(): Promise<void> {
		// nothing to abort
	}
}

registerSingleton(ILocalTranscriptionService, LocalTranscriptionService, InstantiationType.Delayed);
