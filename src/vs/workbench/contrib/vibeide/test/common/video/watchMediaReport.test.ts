/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { clampVideoToolMaxFrames } from '../../../common/video/vibeVideoConfiguration.js';
import { IWatchedMedia, WATCH_MAX_TRANSCRIPT_CHARS, composeFrameDescriptionPrompt, composeWatchPrompt, composeWatchToolReport, parseFrameDescriptions } from '../../../common/video/watchMediaReport.js';

suite('watchMediaReport', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const video: IWatchedMedia = {
		target: '/ws/app/demo.mp4',
		kind: 'video',
		title: 'Демо',
		durationSec: 754,
		frameTimes: [0, 41, 252],
		transcriptText: '1\n00:00:01,000 --> 00:00:03,000\nПривет',
		transcriptLabel: 'субтитры',
	};
	const audio: IWatchedMedia = { target: 'https://x.test/a.mp3', kind: 'audio', frameTimes: [], transcriptText: '[00:00–00:04] алло', transcriptLabel: 'распознан локально' };

	suite('сообщение /watch', () => {
		test('видео: заголовок, соответствие кадров тайм-кодам, транскрипт и общее задание', () => {
			assert.strictEqual(composeWatchPrompt(video, ''), [
				'Разбор видео по команде /watch.',
				'Источник: /ws/app/demo.mp4',
				'Название: Демо',
				'Длительность: 12:34',
				'',
				'К сообщению приложены 3 кадров, вырезанных по сменам сцен (в порядке времени). Соответствие кадров тайм-кодам:',
				'Кадр 1 — 00:00',
				'Кадр 2 — 00:41',
				'Кадр 3 — 04:12',
				'',
				'Транскрипт (субтитры):',
				'1\n00:00:01,000 --> 00:00:03,000\nПривет',
				'',
				'Задание: составь разбор видео: 1) TL;DR в 3–5 строк; 2) ключевые моменты с тайм-кодами; 3) что показано на экране, но не проговорено в звуке; 4) заметные цитаты/моменты с тайм-кодами. Ссылайся на кадры по номерам и тайм-кодам.',
			].join('\n'));
		});

		test('аудио: кадров нет, вопрос человека заменяет общее задание', () => {
			assert.strictEqual(composeWatchPrompt(audio, 'о чём договорились?'), [
				'Разбор аудиозаписи по команде /watch.',
				'Источник: https://x.test/a.mp3',
				'',
				'Транскрипт (распознан локально):',
				'[00:00–00:04] алло',
				'',
				'Задание: о чём договорились?',
			].join('\n'));
		});

		test('нет транскрипта — модель получает прямое «анализируй только кадры»; длинный транскрипт обрезается и это названо', () => {
			assert.ok(composeWatchPrompt({ ...video, transcriptText: undefined, transcriptLabel: 'нет' }, '').includes('Транскрипта нет (нет) — анализируй только кадры.'));
			const long = composeWatchPrompt({ ...video, transcriptText: 'я'.repeat(WATCH_MAX_TRANSCRIPT_CHARS + 500) }, '');
			assert.deepStrictEqual([long.includes('Транскрипт (субтитры; обрезан по лимиту):'), long.includes('я'.repeat(WATCH_MAX_TRANSCRIPT_CHARS)), long.includes('я'.repeat(WATCH_MAX_TRANSCRIPT_CHARS + 1))], [true, true, false]);
		});
	});

	suite('ответ инструмента', () => {
		test('кадры описаны: строка на кадр с тайм-кодом; кадр, которого модель не описала, остаётся без описания', () => {
			const text = composeWatchToolReport(video, { kind: 'described', model: 'anthropic/claude-sonnet-5', descriptions: new Map([[1, 'заставка'], [3, 'график продаж']]) }, 'что показали?');
			assert.strictEqual(text, [
				'Разобрано: видео «Демо».',
				'Источник: /ws/app/demo.mp4',
				'Название: Демо',
				'Длительность: 12:34',
				'',
				'Кадры (3) сняты по сменам сцен, а не через равные промежутки: описал anthropic/claude-sonnet-5.',
				'[00:00] Кадр 1: заставка',
				'[00:41] Кадр 2',
				'[04:12] Кадр 3: график продаж',
				'',
				'Транскрипт (субтитры):',
				'1\n00:00:01,000 --> 00:00:03,000\nПривет',
				'',
				'Вопрос: что показали?',
			].join('\n'));
		});

		test('рассмотреть кадры было некому — ответ прямо говорит об этом и даёт причину, а тайм-коды остаются', () => {
			const text = composeWatchToolReport(video, { kind: 'unseen', reason: 'модель чата — «Авто».' }, '');
			assert.deepStrictEqual(
				[text.includes('картинок в ответе инструмента нет, и описать их было некому: модель чата — «Авто».'), text.includes('[04:12] Кадр 3\n'), text.endsWith('Вопрос: Перескажи содержание по существу, с опорой на тайм-коды.')],
				[true, true, true]);
		});

		test('кадры приложены картинками — текст называет порядок и тайм-коды', () => {
			const text = composeWatchToolReport(video, { kind: 'attached' }, '');
			assert.ok(text.includes('они приложены к ответу картинками, по порядку:\n[00:00] Кадр 1\n[00:41] Кадр 2\n[04:12] Кадр 3'));
		});

		test('аудио: раздела кадров нет; нет транскрипта у видео — «не выдумывай реплики», у аудио этой приписки нет', () => {
			const withAudio = composeWatchToolReport(audio, { kind: 'unseen', reason: '' }, '');
			assert.deepStrictEqual([withAudio.includes('Кадры'), withAudio.startsWith('Разобрано: аудиозапись.')], [false, true]);
			const mute = composeWatchToolReport({ ...video, transcriptText: undefined, transcriptLabel: 'нет звуковой дорожки' }, { kind: 'attached' }, '');
			assert.ok(mute.includes('Транскрипта нет (нет звуковой дорожки). Опирайся только на кадры и не выдумывай реплики.'));
			assert.ok(composeWatchToolReport({ ...audio, transcriptText: undefined, transcriptLabel: 'нет' }, { kind: 'unseen', reason: '' }, '').includes('Транскрипта нет (нет).\n'));
		});
	});

	suite('описание кадров', () => {
		test('просьба к модели: номера, тайм-коды, и вопрос человека как подсказка, на что смотреть', () => {
			assert.strictEqual(composeFrameDescriptionPrompt([3, 75], 'какая цена?'), [
				'К сообщению приложены 2 кадров записи, вырезанных по сменам сцен, в порядке времени.',
				'Опиши каждый кадр одной строкой в формате «N: что видно» — N номер кадра. Называй то, что есть на экране: окно или страницу, текст, цифры, графики, людей и их действия.',
				'Без вступления и итога, без пересказа звука, ничего не выдумывай: нечитаемое пиши как нечитаемое.',
				'Соответствие кадров тайм-кодам:',
				'Кадр 1 — 00:03',
				'Кадр 2 — 01:15',
				'',
				'Человек хочет узнать о записи: какая цена?',
				'Подробнее описывай то, что относится к этому вопросу.',
			].join('\n'));
		});

		test('ответ разбирается по номерам, как бы модель ни оформила нумерацию', () => {
			const answer = [
				'Вот описание:',
				'1: терминал с логом',
				'2. браузер, страница входа',
				'3) **график** продаж за год',
				'- 4 — таблица цен',
				'Кадр 5: пустой экран',
				'**6**: слайд',
				'7: вне диапазона',
				'2: второй раз про то же кадр не перетирает',
			].join('\n');
			assert.deepStrictEqual([...parseFrameDescriptions(answer, 6)], [
				[1, 'терминал с логом'],
				[2, 'браузер, страница входа'],
				[3, 'график продаж за год'],
				[4, 'таблица цен'],
				[5, 'пустой экран'],
				[6, 'слайд'],
			]);
		});

		test('ответ без нумерации не даёт описаний — тогда ответ инструмента честно называет это, а не выдаёт чужой текст за описание', () => {
			assert.strictEqual(parseFrameDescriptions('На записи показан интерфейс редактора и графики.', 5).size, 0);
		});
	});

	test('предел кадров инструмента: число зажато в границы, мусор заменяется умолчанием', () => {
		assert.deepStrictEqual([clampVideoToolMaxFrames(0), clampVideoToolMaxFrames(7.6), clampVideoToolMaxFrames(500), clampVideoToolMaxFrames('десять'), clampVideoToolMaxFrames(undefined)], [1, 8, 48, 12, 12]);
	});
});
