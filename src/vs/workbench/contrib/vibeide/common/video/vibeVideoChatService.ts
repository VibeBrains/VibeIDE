/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Video analysis (/watch) — renderer facade contract. Implementation is desktop-only
 * (`electron-browser/video/vibeVideoChatService.ts`, wired via `workbench.desktop.main.ts`):
 * it owns the tools download consent, drives the main-process pipeline over
 * `vibeide-channel-video`, turns extracted frames into chat image attachments and sends
 * the composed vision request into the chat thread. This facade is what the React chat
 * consumes for the `/watch` slash command.
 */

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

export const IVibeVideoChatService = createDecorator<IVibeVideoChatService>('vibeVideoChatService');

export interface IVibeVideoChatState {
	/** False when the feature is disabled (`vibeide.video.enabled`) or the platform has no tools build. */
	readonly available: boolean;
	/** True while a /watch pipeline is running (one at a time). */
	readonly running: boolean;
}

export interface IVibeVideoChatService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeState: Event<IVibeVideoChatState>;

	getState(): IVibeVideoChatState;

	/**
	 * Full /watch cycle for a chat thread: vision-model gate → tools download (with consent)
	 * → main-process pipeline (subtitles, video, scene frames) → optional STT fallback →
	 * frames + transcript composed into one vision request sent into the thread.
	 * Never rejects: every failure ends in a user-facing notification.
	 *
	 * @param input URL (YouTube/Loom/direct media) or absolute local file path.
	 * @param userHint Optional user question appended to the analysis prompt.
	 */
	startWatch(threadId: string, input: string, userHint: string): Promise<void>;

	/** Cancel the running pipeline (kills child processes, cleans temp files). */
	cancel(): void;
}
