/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Общий seam внешних вложений (ATTACHMENTS-1026): drop на композере и change скрытого input
// скрепки проходят через routeAttachmentFiles. Пустой/unknown MIME восстанавливается по
// расширению имени; всё вне изображений и PDF уходит в unsupported — вызывающий код показывает
// видимую ошибку вместо молчаливого отбрасывания файла

/** Расширение → MIME: только поддерживаемые типы, расширение поддержки не заявлено */
const EXTENSION_MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	svg: 'image/svg+xml',
	pdf: 'application/pdf',
};

const UNKNOWN_MIME_TYPES = new Set(['', 'application/octet-stream']);

export interface RoutedAttachmentFiles {
	images: File[];
	pdfs: File[];
	/** файлы вне поддерживаемых типов — показать ошибку, не молчать */
	unsupported: File[];
}

/** MIME файла: как есть, если известен; иначе по расширению из таблицы; иначе пустая строка */
export function resolveAttachmentMime(file: File): string {
	if (!UNKNOWN_MIME_TYPES.has(file.type)) {
		return file.type;
	}
	const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
	return EXTENSION_MIME[ext] ?? '';
}

/** Единый вход для drop и скрепки: раскладывает файлы по обработчикам, не теряя неподдержанные */
export function routeAttachmentFiles(files: File[]): RoutedAttachmentFiles {
	const result: RoutedAttachmentFiles = { images: [], pdfs: [], unsupported: [] };
	for (const file of files) {
		const mime = resolveAttachmentMime(file);
		// File с восстановленным MIME, чтобы downstream-цепочка (validate/process/submit) видела тип
		const normalized = mime === file.type
			? file
			: new File([file], file.name, { type: mime, lastModified: file.lastModified });
		if (mime.startsWith('image/')) {
			result.images.push(normalized);
		} else if (mime === 'application/pdf') {
			result.pdfs.push(normalized);
		} else {
			result.unsupported.push(file);
		}
	}
	return result;
}

/** Текст видимой ошибки для неподдержанных файлов (русский, с именами) */
export function unsupportedAttachmentsMessage(files: File[]): string {
	const names = files.map(f => f.name).join(', ');
	return `Неподдерживаемый тип файла: ${names}. Прикреплять можно изображения (PNG, JPEG, WebP, GIF, SVG) и PDF`;
}
