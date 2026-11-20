/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * Схема прежнего снимка файла навыка в diff «что изменилось на диске»
 * Снимок отдаёт поставщик содержимого только для чтения: безымянный буфер на его месте спрашивал при закрытии,
 * куда сохранить «Untitled-N.md», и человек думал, что обновление навыка ещё надо принять
 */
export const VIBE_SKILL_PREVIOUS_SCHEME = 'vibe-skill-previous';

/**
 * Адрес прежнего снимка для файла [file]: путь тот же, метка открытия — в query
 * Метка у каждого изменения своя: иначе повторный diff в той же сессии получил бы модель прошлого снимка
 */
export function skillSnapshotResource(file: URI, stamp: string): URI {
	return URI.from({ scheme: VIBE_SKILL_PREVIOUS_SCHEME, path: file.path, query: stamp });
}
