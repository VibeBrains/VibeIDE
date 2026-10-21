/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Video analysis (/watch) — desktop renderer implementation (contract in
 * `common/video/vibeVideoChatService.ts`)
 *
 * Разбор записи делает движок (`vibeWatchMediaService.ts`): гейт vision, инструменты, конвейер, расшифровка.
 * Здесь остаётся то, что относится к чату: кадры (JPEG на диске) → `ChatImageAttachment[]`, транскрипт и
 * соответствие кадров тайм-кодам → одно vision-сообщение, отправленное через
 * `IChatThreadService.addUserMessageAndStreamResponse({ images, displayContent })`
 */

import { localize } from '../../../../../nls.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IVibeVideoChatService } from '../../common/video/vibeVideoChatService.js';
import { IVibeWatchMediaService, IPreparedWatch } from '../../common/video/vibeWatchMediaService.js';
import { formatVideoTimecode } from '../../common/video/vibeVideoTypes.js';
import { composeWatchPrompt } from '../../common/video/watchMediaReport.js';
import { ChatImageAttachment } from '../../common/chatThreadServiceTypes.js';
import { IChatThreadService } from '../../browser/chatThreadService.js';

class VibeVideoChatService extends Disposable implements IVibeVideoChatService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IVibeWatchMediaService private readonly watchMedia: IVibeWatchMediaService,
		@INotificationService private readonly notificationService: INotificationService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
	) {
		super();
	}

	get onDidChangeState() {
		return this.watchMedia.onDidChangeState;
	}

	getState() {
		return this.watchMedia.getState();
	}

	cancel(): void {
		this.watchMedia.cancel();
	}

	// ── /watch cycle ─────────────────────────────────────────────────────────

	async startWatch(threadId: string, input: string, userHint: string): Promise<void> {
		const typed = input.trim();
		if (!typed) {
			this.notificationService.info(localize('vibeVideo.usage', "Использование: /watch <ссылка или путь к видео> [вопрос]. Пример: /watch https://youtu.be/… что показано в демо?"));
			return;
		}
		try {
			const run = await this.watchMedia.run({ input: typed, requireVision: true }, prepared => this.sendToChat(threadId, typed, userHint, prepared));
			if (run.kind === 'refused') {
				this.notificationService.notify({
					severity: run.severity === 'error' ? Severity.Error : run.severity === 'warn' ? Severity.Warning : Severity.Info,
					message: run.message,
				});
			}
		} catch (error) {
			this.watchMedia.reportFailure(error);
		}
	}

	private async sendToChat(threadId: string, typed: string, userHint: string, prepared: IPreparedWatch): Promise<void> {
		const { media } = prepared;
		const isAudio = media.kind === 'audio';
		const images = isAudio ? [] : await this.buildImageAttachments(prepared);
		const userMessage = composeWatchPrompt(media, userHint);
		const attachmentsNote = isAudio
			? localize('vibeVideo.display.audio', "аудио, транскрипт: {0}", media.transcriptLabel)
			: localize('vibeVideo.display.video', "кадров: {0}, транскрипт: {1}", images.length, media.transcriptLabel);
		// В ленте — то, что написал пользователь; абсолютный путь уходит модели в запросе.
		const displayContent = `/watch ${typed}${userHint ? ` — ${userHint}` : ''}\n(${attachmentsNote})`;
		await this.chatThreadService.addUserMessageAndStreamResponse({ userMessage, threadId, images, displayContent });
	}

	private async buildImageAttachments(prepared: IPreparedWatch): Promise<ChatImageAttachment[]> {
		const frames = await prepared.readFrames();
		return frames.map(frame => ({
			id: generateUuid(),
			data: frame.data,
			mimeType: 'image/jpeg',
			filename: `frame-${formatVideoTimecode(frame.timeSec).replace(/:/g, '-')}.jpg`,
			width: frame.width,
			height: frame.height,
			size: frame.sizeBytes,
			uploadStatus: 'success',
		}));
	}
}

registerSingleton(IVibeVideoChatService, VibeVideoChatService, InstantiationType.Delayed);
