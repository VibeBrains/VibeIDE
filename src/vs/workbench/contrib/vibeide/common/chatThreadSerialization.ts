/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { URI } from '../../../../base/common/uri.js';
import { withRefusalKind } from './toolRefusal.js';
import { vibeLog } from './vibeLog.js';

/**
 * Сериализация тредов для хранилища и обратное чтение.
 *
 * Раньше обе функции жили в `chatThreadService` и обслуживали одно значение
 * `THREAD_STORAGE_KEY`: теперь каждый тред лежит отдельным файлом, но формат
 * остался прежним — так старые сохранения читаются без конвертации, а картинки
 * (`Uint8Array`) переживают запись на диск.
 */

/** Запись тредов в строку: `Uint8Array` под ключом `data` уходит в base64. */
export function serializeThreadsForStorage(threads: unknown): string {
	return JSON.stringify(threads, (key, value) => {
		// Convert Uint8Array to base64 string for storage
		if (key === 'data' && value instanceof Uint8Array) {
			// Convert Uint8Array to base64
			const chunkSize = 0x8000; // 32KB chunks to avoid stack overflow
			let binaryString = '';
			for (let i = 0; i < value.length; i += chunkSize) {
				const chunk = value.slice(i, i + chunkSize);
				binaryString += String.fromCharCode(...chunk);
			}
			const base64 = btoa(binaryString);
			return `__base64__:${base64}`;
		}
		return value;
	});
}

/** Чтение строки тредов: восстанавливает `URI` и байты картинок из base64. */
export function parseThreadsFromStorage<T>(threadsStr: string): T {
	return JSON.parse(threadsStr, (key, value) => {
		// A guard's refusal stored as `tool_error` with empty params before the `refused` kind: its card would read a URI off it
		if (value && typeof value === 'object' && value.role === 'tool') {
			return withRefusalKind(value);
		}
		if (value && typeof value === 'object' && value.$mid === 1) { // $mid is the MarshalledId. $mid === 1 means it is a URI
			// `URI.revive` is the cheaper restore path — no full parse, just
			// re-establishes the prototype/methods on the existing object shape.
			// `URI.from` would re-parse the components. For thread restore that
			// can replay hundreds of URIs on workspace open, the difference adds
			// up. Switch is safe because $mid:1 already guarantees a properly
			// shaped URI literal from `JSON.stringify(uri.toJSON())`.
			return URI.revive(value);
		}
		// Restore Uint8Array from base64 string for image data
		// Only process 'data' keys that are directly under image attachment objects
		// Check key === 'data' to match image attachment structure
		if (key === 'data') {
			if (typeof value === 'string' && value.startsWith('__base64__:')) {
				// Handle base64 string format (the normal case)
				try {
					const base64 = value.substring(11); // Remove '__base64__:' prefix
					const binaryString = atob(base64);
					const bytes = new Uint8Array(binaryString.length);
					for (let i = 0; i < binaryString.length; i++) {
						bytes[i] = binaryString.charCodeAt(i);
					}
					return bytes;
				} catch (e) {
					vibeLog.error('chatThread', 'Failed to decode base64 image data in storage reviver', e);
					return value; // Return original value on error
				}
			} else if (Array.isArray(value)) {
				// Handle case where it's already an array but not Uint8Array
				// Only convert if it looks like byte data (all numbers 0-255)
				if (value.length > 0 && value.every((v: unknown) => typeof v === 'number' && v >= 0 && v <= 255)) {
					return new Uint8Array(value as number[]);
				}
			}
			// For objects, don't try to convert here - let it be handled later if needed
			// This prevents infinite recursion and unexpected conversions
		}
		return value;
	});
}
