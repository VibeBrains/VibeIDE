/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveAttachmentMime, routeAttachmentFiles, unsupportedAttachmentsMessage } from '../../browser/attachmentFileRouting.js';

/**
 * Общий seam внешних вложений (ATTACHMENTS-1026): через routeAttachmentFiles проходят и drop
 * на композере, и change скрытого input скрепки. Регрессия: пустой/unknown MIME не должен
 * молча исчезать — файл восстанавливается по расширению либо уходит в unsupported с ошибкой
 */
suite('attachment file routing (drop и скрепка)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const f = (name: string, type: string) => new File([new Uint8Array([1, 2, 3])], name, { type });

	test('typed PNG/PDF проходят как раньше, объект не пересоздаётся', () => {
		const png = f('a.png', 'image/png');
		const pdf = f('b.pdf', 'application/pdf');
		const r = routeAttachmentFiles([png, pdf]);
		assert.strictEqual(r.images.length, 1);
		assert.strictEqual(r.pdfs.length, 1);
		assert.strictEqual(r.unsupported.length, 0);
		assert.strictEqual(r.images[0], png, 'typed-файл должен пройти тот же объект');
		assert.strictEqual(r.pdfs[0], pdf);
	});

	test('пустой MIME с расширением изображения/PDF восстанавливается и роутится', () => {
		const png = f('фото.png', '');
		const pdf = f('doc.pdf', '');
		const r = routeAttachmentFiles([png, pdf]);
		assert.strictEqual(r.unsupported.length, 0, 'пустой MIME не должен теряться молча');
		assert.strictEqual(r.images.length, 1);
		assert.strictEqual(r.pdfs.length, 1);
		assert.strictEqual(r.images[0].type, 'image/png', 'downstream validate/process должны видеть MIME');
		assert.strictEqual(r.images[0].name, 'фото.png');
		assert.strictEqual(r.images[0].size, png.size, 'данные файла сохраняются');
		assert.strictEqual(r.pdfs[0].type, 'application/pdf');
	});

	test('application/octet-stream восстанавливается по расширению', () => {
		const jpg = f('shot.jpg', 'application/octet-stream');
		const r = routeAttachmentFiles([jpg]);
		assert.strictEqual(r.images.length, 1);
		assert.strictEqual(r.images[0].type, 'image/jpeg');
	});

	test('неизвестное расширение уходит в unsupported с именем для видимой ошибки', () => {
		const exe = f('setup.exe', '');
		const doc = f('notes.docx', 'application/octet-stream');
		const r = routeAttachmentFiles([exe, doc]);
		assert.strictEqual(r.images.length, 0);
		assert.strictEqual(r.pdfs.length, 0);
		assert.strictEqual(r.unsupported.length, 2);
		assert.strictEqual(r.unsupported[0], exe);
		const msg = unsupportedAttachmentsMessage(r.unsupported);
		assert.ok(msg.startsWith('Неподдерживаемый тип файла:'), 'заголовок ошибки');
		assert.ok(msg.includes('setup.exe') && msg.includes('notes.docx'), 'сообщение называет оба файла');
		assert.ok(msg.includes('Прикреплять можно изображения (PNG, JPEG, WebP, GIF, SVG) и PDF'), 'перечень поддерживаемых типов');
	});

	test('типизированный image/* вне allow-list роутится в images — ошибку даст validate', () => {
		const tiff = f('scan.tiff', 'image/tiff');
		const r = routeAttachmentFiles([tiff]);
		assert.strictEqual(r.images.length, 1, 'image/* идёт в addImages, visible error там же как раньше');
		assert.strictEqual(r.unsupported.length, 0);
	});

	test('resolveAttachmentMime: регистр расширения не важен, без расширения — пусто', () => {
		assert.strictEqual(resolveAttachmentMime(f('A.JPEG', '')), 'image/jpeg');
		assert.strictEqual(resolveAttachmentMime(f('noext', '')), '');
		assert.strictEqual(resolveAttachmentMime(f('x.png', 'image/png')), 'image/png');
	});
});
