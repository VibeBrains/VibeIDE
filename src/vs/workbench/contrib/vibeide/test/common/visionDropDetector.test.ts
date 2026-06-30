/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { detectVisionDropResponse } from '../../common/visionDropDetector.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('visionDropDetector', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('positive — provider silently dropped the image', () => {

		test('RU: explicit "не вижу изображения, прикрепите файл"', () => {
			assert.strictEqual(
				detectVisionDropResponse('Я не вижу изображения, прикрепите файл.'),
				true,
			);
		});

		test('RU: long apology variant', () => {
			const text = 'Я не вижу изображений, которые вы могли бы иметь в виду, так как в вашем сообщении нет прикреплённого файла или ссылки на фото.';
			assert.strictEqual(detectVisionDropResponse(text), true);
		});

		test('RU: trailing CTA "Пришлите фото, и я опишу его"', () => {
			assert.strictEqual(
				detectVisionDropResponse('Пришлите фото, и я с радостью его опишу!'),
				true,
			);
		});

		test('RU: "В вашем сообщении нет вложений"', () => {
			assert.strictEqual(
				detectVisionDropResponse('К сожалению, в вашем сообщении нет прикреплённого изображения.'),
				true,
			);
		});

		test('EN: "I don\'t see any image in your message"', () => {
			assert.strictEqual(
				detectVisionDropResponse("I don't see any image attached to your message."),
				true,
			);
		});

		test('EN: "I cannot view the image you mentioned"', () => {
			assert.strictEqual(
				detectVisionDropResponse('I cannot view the image you mentioned — could you re-upload it?'),
				true,
			);
		});

		test('EN: "Please attach an image so I can describe it"', () => {
			assert.strictEqual(
				detectVisionDropResponse('Please attach an image so I can take a look.'),
				true,
			);
		});

		test('EN: "It looks like there is no attachment"', () => {
			assert.strictEqual(
				detectVisionDropResponse('It looks like there is no image in your prompt.'),
				true,
			);
		});

		test('EN: "no image was attached"', () => {
			assert.strictEqual(
				detectVisionDropResponse('No image was attached to your request.'),
				true,
			);
		});

	});

	suite('negative — replies that should NOT trigger the detector', () => {

		test('empty / null / whitespace returns false', () => {
			assert.strictEqual(detectVisionDropResponse(''), false);
			assert.strictEqual(detectVisionDropResponse('   '), false);
			assert.strictEqual(detectVisionDropResponse(undefined), false);
			assert.strictEqual(detectVisionDropResponse(null), false);
		});

		test('RU: model successfully described the image', () => {
			assert.strictEqual(
				detectVisionDropResponse('На изображении изображён рабочий стол VS Code с открытым файлом TypeScript.'),
				false,
			);
		});

		test('RU: instructions about how to attach (not a complaint)', () => {
			assert.strictEqual(
				detectVisionDropResponse('Чтобы добавить картинку, нажмите кнопку «скрепка» в панели чата.'),
				false,
			);
		});

		test('RU: discussing source code, no images involved', () => {
			assert.strictEqual(
				detectVisionDropResponse('Я не нашёл подходящих функций в коде. Попробуйте другой поиск.'),
				false,
			);
		});

		test('EN: model successfully described the image', () => {
			assert.strictEqual(
				detectVisionDropResponse('I can see the screenshot. It shows a settings panel with three tabs.'),
				false,
			);
		});

		test('EN: discussing missing function, not attachment', () => {
			assert.strictEqual(
				detectVisionDropResponse("I don't see any function called calculateTax in this file."),
				false,
			);
		});

		test('EN: instructions about how to attach', () => {
			assert.strictEqual(
				detectVisionDropResponse('To attach a screenshot, drag the file into the chat input.'),
				false,
			);
		});

	});

});
