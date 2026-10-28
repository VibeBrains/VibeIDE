/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Вычисляет видимую подпись для inline-кода (codespan) в ответе агента.
 * Полный исходный текст должен оставаться видимым: абсолютные пути не сокращаем
 * до basename, а путь к папке с завершающим слешем не превращаем в пустую строку.
 */
export function getCodespanDisplayText(text: string): string {
	return text;
}
