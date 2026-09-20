/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { OCR_DEFAULT_LANGUAGES, OcrRecognizeRequest, OcrRecognizeResponse, VIBE_OCR_CHANNEL } from '../common/imageQA/ocrTransport.js';
import { setOcrRemoteRecognizer } from '../common/imageQA/ocrService.js';
import { vibeLog } from '../common/vibeLog.js';

/**
 * Подключает распознавание текста, живущее в главном процессе.
 *
 * Одна точка установки: служба распознавания лежит в `common` и вызывается из React-хуков, у
 * которых сервисов воркбенча нет. Здесь же — единственное место, где известно и про канал, и про
 * то, что окно работает в Electron.
 *
 * Почему вообще в главном процессе: в окне `new Worker(<строка>)` запрещён Trusted Types, и
 * распознаватель не поднимался (см. `common/imageQA/ocrTransport.ts`).
 */
export class VibeOcrRemoteContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeOcrRemote';

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super();
		const channel = mainProcessService.getChannel(VIBE_OCR_CHANNEL);

		setOcrRemoteRecognizer(async (image: Uint8Array): Promise<OcrRecognizeResponse> => {
			const request: OcrRecognizeRequest = { imageBase64: encodeBase64(VSBuffer.wrap(image)), languages: OCR_DEFAULT_LANGUAGES };
			try {
				// Исход приходит полем ответа; `call` теряет тип ошибки, поэтому его собственный
				// провал — отдельный случай, и путать их нельзя.
				return await channel.call<OcrRecognizeResponse>('recognize', request);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vibeLog.warn('ocr', `канал распознавания не ответил: ${message}`);
				return { ok: false, error: message };
			}
		});

		this._register({ dispose: () => setOcrRemoteRecognizer(undefined) });
	}
}

registerWorkbenchContribution2(VibeOcrRemoteContribution.ID, VibeOcrRemoteContribution, WorkbenchPhase.AfterRestored);
