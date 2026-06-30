/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Detects whether an LLM reply is symptomatic of a "vision drop" — the user attached an
 * image, the model claims to support vision (so our hard-block let it through), but the
 * provider silently stripped the image and the model is now apologising or asking for
 * the attachment.
 *
 * Conservative by design: only well-known phrasings that explicitly reference a missing
 * attachment / image / file. We deliberately avoid weak triggers like "I don't see X" on
 * its own — many legitimate replies contain that phrase about source code, etc. The
 * caller is expected to gate this check on `originalUserMessage.images?.length > 0`.
 */

const RU_PATTERNS: readonly RegExp[] = [
	// "не вижу [никаких] изображений / прикреплённого файла / вложений"
	/не\s+(вижу|могу\s+увидеть|могу\s+(прочитать|открыть|обработать|проанализировать))[^.!?\n]{0,80}(изображен|картин|фотограф|фото|вложен|прикреплён|прикреплен|приложен|файл)/i,
	// "в вашем/твоём сообщении нет / отсутствует [...] прикреплённого / вложения / файла / изображения"
	/в\s+(вашем|твоём|твоем|сообщении)[^.!?\n]{0,40}(нет|отсутствует)[^.!?\n]{0,80}(файл|изображен|вложен|прикреплён|прикреплен|приложен|картин|фото)/i,
	// "нет прикреплённого/приложенного файла / изображения / вложения"
	/нет[^.!?\n]{0,30}(прикреплён|прикреплен|приложен|вложен)[^.!?\n]{0,60}(файл|изображен|картин|фото)/i,
	// "пришлите / прикрепите / загрузите фото / изображение [, чтобы / и я опишу]"
	/(пришлите|прикрепите|загрузите|поделитесь)[^.!?\n]{0,50}(изображен|фото|картин)[^.!?\n]{0,120}(опиш|анализ|увидеть|увижу|помог|расскаж)/i,
	// "пришлите фото, и я с радостью..." — короткое CTA в конце ответа
	/(пришлите|прикрепите)\s+(его|её|ее|изображение|фото|картинку|файл|вложен)/i,
];

const EN_PATTERNS: readonly RegExp[] = [
	// "I don't / cannot / am unable to see/view/access the image/attachment"
	// NOTE: deliberately excludes `file` / `attached` — too many code-discussion replies
	// say "I don't see this function in the file" or "with the value attached to X".
	/(?:i\s+)?(don't|do\s+not|cannot|can't|am\s+not\s+able\s+to|am\s+unable\s+to|unable\s+to)\s+(see|view|access|read|process|open|find|detect)[^.!?\n]{0,80}(image|picture|photo|attachment|screenshot|upload)/i,
	// "no image/attachment was attached / in your message"
	/(no|there\s+(is|are)\s+no|i\s+don't\s+see\s+any)[^.!?\n]{0,40}(image|picture|photo|attachment|file)[^.!?\n]{0,80}(attached|uploaded|in\s+your\s+(message|request|prompt|chat)|in\s+the\s+(request|conversation|chat|message))/i,
	// "please attach/share/send/upload an image"
	/(please|kindly|could\s+you|would\s+you)\s+(attach|share|send|upload|provide|include|paste)[^.!?\n]{0,60}(image|picture|photo|file|attachment|screenshot)/i,
	// "it seems / it looks like there is no image / attachment"
	/(it\s+(seems|looks|appears)|looks\s+like)[^.!?\n]{0,40}(no|without)[^.!?\n]{0,40}(image|picture|photo|attachment|file)/i,
];

export const VISION_DROP_PATTERNS = {
	ru: RU_PATTERNS,
	en: EN_PATTERNS,
} as const;

/**
 * Returns true iff the reply text matches one of the conservative "model could not see
 * the image" phrasings. Empty / undefined input → false. Long unrelated replies that
 * happen to contain the phrase in passing will still match — that is acceptable, since
 * we only run this when an image was actually attached.
 */
export function detectVisionDropResponse(text: string | undefined | null): boolean {
	if (!text || typeof text !== 'string') {
		return false;
	}
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return false;
	}
	for (const re of RU_PATTERNS) {
		if (re.test(trimmed)) {
			return true;
		}
	}
	for (const re of EN_PATTERNS) {
		if (re.test(trimmed)) {
			return true;
		}
	}
	return false;
}
